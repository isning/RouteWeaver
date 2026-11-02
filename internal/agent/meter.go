package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"routeweaver/internal/entrypolicy"
	"sync"
)

type terminalCustody struct {
	EvidenceDigest string       `json:"evidenceDigest"`
	Receipt        MeterReceipt `json:"receipt"`
}
type meterDisk struct {
	TerminalCustody map[string]terminalCustody    `json:"terminalCustody,omitempty"`
	Schema          int                           `json:"schema"`
	Scope           Scope                         `json:"scope"`
	Epoch           string                        `json:"epoch"`
	Next            uint64                        `json:"next,string"`
	Acked           uint64                        `json:"acked,string"`
	Pending         []MeterBatch                  `json:"pending"`
	LastReceipt     *MeterReceipt                 `json:"lastReceipt,omitempty"`
	ManagedSources  map[string]managedMeterCursor `json:"managedSources,omitempty"`
}
type MeterSpool struct {
	collectMu sync.Mutex
	mu        sync.Mutex
	root      string
	disk      meterDisk
	lock      *os.File
	closed    bool
}

// OpenMeterSpool takes its own root lock. The epoch is an explicit scope, not a
// guessed native counter reset. A bounded durable outbox survives agent restart.
func OpenMeterSpool(root string, scope Scope, epoch string) (*MeterSpool, error) {
	if epoch == "" || len(epoch) > 128 {
		return nil, errors.New("explicit meter stream epoch required")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private meter storage required")
	}
	lock, err := lockRoot(root)
	if err != nil {
		return nil, err
	}
	s := &MeterSpool{root: root, lock: lock, disk: meterDisk{Schema: 2, Scope: scope, Epoch: epoch, Next: 1, Pending: []MeterBatch{}}}
	if info, statErr := os.Stat(filepath.Join(root, "meter.json")); statErr == nil && info.Size() > 8<<20 {
		s.Close()
		return nil, errors.New("meter journal byte bound exceeded")
	}
	err = readJSON(filepath.Join(root, "meter.json"), &s.disk)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.Close()
		return nil, errors.New("meter journal unreadable")
	}
	if (s.disk.Schema != 1 && s.disk.Schema != 2) || s.disk.Scope != scope || s.disk.Epoch != epoch || s.disk.Next == 0 {
		s.Close()
		return nil, errors.New("meter journal scope mismatch")
	}
	rawState, marshalErr := json.Marshal(s.disk)
	if marshalErr != nil || len(rawState) > 8<<20 || len(s.disk.Pending) > 128 {
		s.Close()
		return nil, errors.New("meter journal bounds exceeded")
	}
	if len(s.disk.TerminalCustody) > 128 {
		s.Close()
		return nil, errors.New("terminal custody bound exceeded")
	}
	for epoch, c := range s.disk.TerminalCustody {
		if !journalEpoch.MatchString(epoch) || !validTerminalDigest(c.EvidenceDigest) || c.Receipt.CustodyVersion != entrypolicy.TerminalCustodyVersion || c.Receipt.TerminalEvidenceDigest != c.EvidenceDigest || c.Receipt.Sequence == 0 || !validTerminalDigest(c.Receipt.Digest) || c.Receipt.Sequence > s.disk.Acked || c.Receipt.StreamEpoch != s.disk.Epoch {
			s.Close()
			return nil, errors.New("invalid terminal custody state")
		}
	}
	expected := s.disk.Acked + 1
	for _, b := range s.disk.Pending {
		digest := b.Digest
		b.Digest = ""
		raw, _ := json.Marshal(b)
		sum := sha256.Sum256(raw)
		if b.Scope != scope || b.StreamEpoch != epoch || b.Sequence != expected || hex.EncodeToString(sum[:]) != digest {
			s.Close()
			return nil, errors.New("meter journal batch identity mismatch")
		}
		if b.TerminalEvidence != nil {
			if err := validateTerminalBatch(b); err != nil {
				s.Close()
				return nil, err
			}
		}
		expected++
	}
	if expected != s.disk.Next {
		s.Close()
		return nil, errors.New("meter journal sequence mismatch")
	}
	// Persist the downgrade fence before collection can retire any evidence.
	if s.disk.Schema == 1 {
		s.disk.Schema = 2
		if err := writeJSON(filepath.Join(root, "meter.json"), s.disk); err != nil {
			s.Close()
			return nil, err
		}
	}
	return s, nil
}

func (s *MeterSpool) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return unlockRoot(s.lock)
}
func (s *MeterSpool) Enqueue(samples []MeterSample) (MeterBatch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enqueueLocked(samples, nil)
}
func (s *MeterSpool) enqueueLocked(samples []MeterSample, sources map[string]managedMeterCursor) (MeterBatch, error) {
	return s.enqueueEvidenceLocked(samples, sources, nil)
}
func (s *MeterSpool) enqueueEvidenceLocked(samples []MeterSample, sources map[string]managedMeterCursor, evidence *entrypolicy.TerminalEvidence) (MeterBatch, error) {
	if s.closed {
		return MeterBatch{}, errors.New("meter spool closed")
	}
	if (len(samples) == 0 && evidence == nil) || len(samples) > 1000 || len(s.disk.Pending) >= 128 || s.disk.Next == math.MaxUint64 {
		return MeterBatch{}, errors.New("meter spool bounds exceeded")
	}
	seen := map[string]bool{}
	for _, v := range samples {
		if v.SampleID == "" || v.CounterEpoch == "" || v.SubjectID == "" || v.RouteID == "" || v.PolicyRevision == "" || v.CycleID == "" || v.MeasurementLayer == "" || v.ObservedAt.IsZero() || seen[v.SampleID] {
			return MeterBatch{}, errors.New("meter sample identity or attribution missing")
		}
		seen[v.SampleID] = true
	}
	b := MeterBatch{TerminalEvidence: evidence, Scope: s.disk.Scope, StreamEpoch: s.disk.Epoch, Sequence: s.disk.Next, Samples: append([]MeterSample{}, samples...)}
	if evidence != nil {
		if err := validateTerminalBatch(b); err != nil {
			return MeterBatch{}, err
		}
	}
	raw, _ := json.Marshal(b)
	if len(raw) > 1<<20 {
		return MeterBatch{}, errors.New("meter batch too large")
	}
	sum := sha256.Sum256(raw)
	b.Digest = hex.EncodeToString(sum[:])
	finalRaw, _ := json.Marshal(b)
	if len(finalRaw) > 1<<20 {
		return MeterBatch{}, errors.New("meter batch too large")
	}
	next := s.disk
	if sources != nil {
		next.ManagedSources = sources
	}
	next.Next++
	next.Pending = append(append([]MeterBatch(nil), s.disk.Pending...), b)
	serialized, err := json.Marshal(next)
	if err != nil || len(serialized) > 8<<20 {
		return MeterBatch{}, errors.New("meter outbox byte bound exceeded; collection must backpressure")
	}
	if err := writeJSON(filepath.Join(s.root, "meter.json"), next); err != nil {
		return MeterBatch{}, err
	}
	s.disk = next
	return cloneBatch(b), nil
}
func cloneBatch(b MeterBatch) MeterBatch {
	if b.Samples != nil {
		b.Samples = append([]MeterSample{}, b.Samples...)
	}
	if b.TerminalEvidence != nil {
		b.TerminalEvidence = b.TerminalEvidence.Clone()
	}
	return b
}
func (s *MeterSpool) Pending() []MeterBatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MeterBatch, len(s.disk.Pending))
	for i, b := range s.disk.Pending {
		out[i] = cloneBatch(b)
	}
	return out
}

// Ack accepts only the first pending exact receipt. Acknowledging a later batch
// cannot silently skip earlier evidence, and a changed digest is not a retry.
func (s *MeterSpool) Ack(receipt MeterReceipt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("meter spool closed")
	}
	if s.disk.LastReceipt != nil && *s.disk.LastReceipt == receipt {
		return nil
	}
	if len(s.disk.Pending) == 0 {
		return errors.New("no pending batch")
	}
	b := s.disk.Pending[0]
	if receipt.StreamEpoch != b.StreamEpoch || receipt.Sequence != b.Sequence || receipt.Digest != b.Digest {
		return errors.New("meter receipt mismatch or sequence gap")
	}
	if err := validateCustodyReceipt(b, receipt); err != nil {
		return err
	}
	next := s.disk
	if b.TerminalEvidence != nil {
		next.TerminalCustody = make(map[string]terminalCustody, len(s.disk.TerminalCustody)+1)
		for k, v := range s.disk.TerminalCustody {
			next.TerminalCustody[k] = v
		}
		e := b.TerminalEvidence
		if previous, exists := next.TerminalCustody[e.RuntimeEpoch]; exists && previous.EvidenceDigest != e.Digest {
			return errors.New("conflicting terminal custody")
		}
		next.TerminalCustody[e.RuntimeEpoch] = terminalCustody{EvidenceDigest: e.Digest, Receipt: receipt}
		if len(next.TerminalCustody) > 128 {
			return errors.New("terminal custody count bound exceeded")
		}
	}
	next.Acked = b.Sequence
	next.LastReceipt = &receipt
	next.Pending = append([]MeterBatch(nil), s.disk.Pending[1:]...)
	if err := s.persistRetirement(next); err != nil {
		return err
	}
	s.disk = next
	return nil
}
