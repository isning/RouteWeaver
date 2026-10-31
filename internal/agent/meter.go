package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
)

type meterDisk struct {
	Schema         int                           `json:"schema"`
	Scope          Scope                         `json:"scope"`
	Epoch          string                        `json:"epoch"`
	Next           uint64                        `json:"next,string"`
	Acked          uint64                        `json:"acked,string"`
	Pending        []MeterBatch                  `json:"pending"`
	LastReceipt    *MeterReceipt                 `json:"lastReceipt,omitempty"`
	ManagedSources map[string]managedMeterCursor `json:"managedSources,omitempty"`
}
type MeterSpool struct {
	mu     sync.Mutex
	root   string
	disk   meterDisk
	lock   *os.File
	closed bool
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
	s := &MeterSpool{root: root, lock: lock, disk: meterDisk{Schema: 1, Scope: scope, Epoch: epoch, Next: 1, Pending: []MeterBatch{}}}
	err = readJSON(filepath.Join(root, "meter.json"), &s.disk)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.Close()
		return nil, errors.New("meter journal unreadable")
	}
	if s.disk.Schema != 1 || s.disk.Scope != scope || s.disk.Epoch != epoch || s.disk.Next == 0 {
		s.Close()
		return nil, errors.New("meter journal scope mismatch")
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
		expected++
	}
	if expected != s.disk.Next {
		s.Close()
		return nil, errors.New("meter journal sequence mismatch")
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
	if s.closed {
		return MeterBatch{}, errors.New("meter spool closed")
	}
	if len(samples) == 0 || len(samples) > 1000 || len(s.disk.Pending) >= 128 || s.disk.Next == math.MaxUint64 {
		return MeterBatch{}, errors.New("meter spool bounds exceeded")
	}
	seen := map[string]bool{}
	for _, v := range samples {
		if v.SampleID == "" || v.CounterEpoch == "" || v.SubjectID == "" || v.RouteID == "" || v.PolicyRevision == "" || v.CycleID == "" || v.MeasurementLayer == "" || v.ObservedAt.IsZero() || seen[v.SampleID] {
			return MeterBatch{}, errors.New("meter sample identity or attribution missing")
		}
		seen[v.SampleID] = true
	}
	b := MeterBatch{Scope: s.disk.Scope, StreamEpoch: s.disk.Epoch, Sequence: s.disk.Next, Samples: append([]MeterSample(nil), samples...)}
	raw, _ := json.Marshal(b)
	if len(raw) > 1<<20 {
		return MeterBatch{}, errors.New("meter batch too large")
	}
	sum := sha256.Sum256(raw)
	b.Digest = hex.EncodeToString(sum[:])
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
	b.Samples = append([]MeterSample(nil), b.Samples...)
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
	next := s.disk
	next.Acked = b.Sequence
	next.LastReceipt = &receipt
	next.Pending = append([]MeterBatch(nil), s.disk.Pending[1:]...)
	if err := writeJSON(filepath.Join(s.root, "meter.json"), next); err != nil {
		return err
	}
	s.disk = next
	return nil
}
