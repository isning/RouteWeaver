package store

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

const maxTerminalInboxBytes = 1 << 20

// Keep this credential-free wire projection in canonical MeterBatch field order;
// no runtime/HTTP dependency is needed in persistence. Digest validation below
// refuses a rewritten envelope rather than trusting a matching receipt string.
type terminalWireBatch struct {
	TerminalEvidence *entrypolicy.TerminalEvidence `json:"terminalEvidence,omitempty"`
	Scope            domain.InstanceScope          `json:"scope"`
	StreamEpoch      string                        `json:"streamEpoch"`
	Sequence         uint64                        `json:"sequence,string"`
	Digest           string                        `json:"digest"`
	Samples          []CounterSample               `json:"samples"`
}

// TerminalMeterEvidence is custody of a reviewed native measurement, not a
// per-flow budget resolution. It never authorizes a refund or implies settlement.
// EntryID, InboundTag and CredentialVersion inside snapshots are agent-reported
// runtime context, not independently verified per-presence allocation. Historical
// meter bindings verify account/subject/route/policy/cycle; mutable current entry
// configuration must not invalidate custody of an earlier stopped generation.
type TerminalMeterEvidence struct {
	ReceiptID        string                        `json:"receiptId"`
	StreamEpoch      string                        `json:"streamEpoch"`
	Sequence         uint64                        `json:"sequence,string"`
	BatchDigest      string                        `json:"batchDigest"`
	CustodyVersion   int                           `json:"custodyVersion"`
	TerminalEvidence *entrypolicy.TerminalEvidence `json:"terminalEvidence"`
}

func validateTerminalCounterBatch(batch CounterBatch, original any) ([]byte, error) {
	if batch.TerminalEvidence == nil {
		return nil, nil
	}
	evidence := batch.TerminalEvidence
	if err := evidence.Validate(); err != nil {
		return nil, err
	}
	if evidence.InstanceID != batch.InstanceID || evidence.EnrollmentEpoch != batch.EnrollmentEpoch || len(batch.Samples) != 0 {
		return nil, fmt.Errorf("terminal evidence scope or sample count mismatch")
	}
	raw, err := json.Marshal(original)
	if err != nil || len(raw) > maxTerminalInboxBytes {
		return nil, fmt.Errorf("terminal meter envelope exceeds custody byte bound")
	}
	var wire terminalWireBatch
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&wire); err != nil {
		return nil, err
	}
	if wire.Scope.NodeID != evidence.NodeID || wire.Scope.InstanceID != batch.InstanceID || wire.Scope.EnrollmentEpoch != batch.EnrollmentEpoch || wire.StreamEpoch != batch.StreamEpoch || wire.Sequence != batch.Sequence || wire.Digest != batch.Digest || len(wire.Samples) != 0 || (wire.TerminalEvidence == nil || wire.TerminalEvidence.Validate() != nil || wire.TerminalEvidence.Digest != evidence.Digest) {
		return nil, fmt.Errorf("terminal original envelope differs from validated batch")
	}
	claimed := wire.Digest
	wire.Digest = ""
	canonical, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canonical)
	if claimed != hex.EncodeToString(sum[:]) {
		return nil, fmt.Errorf("terminal envelope digest mismatch")
	}
	// Reserve actual response overhead, not guessed headroom: every accepted
	// proof remains retrievable within the same 1 MiB HTTP output bound.
	receiptID := fmt.Sprintf("%s:%s:%s:%d", batch.InstanceID, batch.EnrollmentEpoch, batch.StreamEpoch, batch.Sequence)
	response, err := json.Marshal(TerminalMeterEvidence{ReceiptID: receiptID, StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, BatchDigest: batch.Digest, CustodyVersion: 1, TerminalEvidence: evidence})
	if err != nil || len(response)+1 > maxTerminalInboxBytes {
		return nil, fmt.Errorf("terminal evidence response exceeds custody byte bound")
	}
	return raw, nil
}

type terminalQuery interface{ QueryRow(string, ...any) *sql.Row }

// Inspect length in SQL before allocating/decrypting one indexed inbox record.
func (s *Store) readBoundedTerminalInbox(q terminalQuery, id string, out any) error {
	var data []byte
	var size int
	bound := maxTerminalInboxBytes + s.aead.NonceSize() + s.aead.Overhead()
	err := q.QueryRow(`SELECT length(data), CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind='meter-inbox' AND id=?`, bound, id).Scan(&size, &data)
	if err == sql.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if size > bound {
		return fmt.Errorf("terminal inbox record exceeds custody byte bound")
	}
	return s.open("meter-inbox", id, data, out)
}

// MeterTerminalEvidence performs an exact, bounded indexed lookup. Receipt
// locators can be recovered by DiscoverMeterTerminalEvidence without an agent
// spool or remembered stream; neither path scans unbounded raw history.
func (s *Store) MeterTerminalEvidence(instance, enrollment, stream string, sequence uint64) (TerminalMeterEvidence, error) {
	var out TerminalMeterEvidence
	if !domain.ValidID(instance) || !domain.ValidID(enrollment) || stream == "" || len(stream) > 128 || strings.ContainsAny(stream, ":/\\") || sequence == 0 {
		return out, fmt.Errorf("invalid terminal evidence receipt identity")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	id := fmt.Sprintf("%s:%s:%s:%d", instance, enrollment, stream, sequence)
	var raw json.RawMessage
	if err = s.readBoundedTerminalInbox(tx, id, &raw); err != nil {
		return out, err
	}
	var wire terminalWireBatch
	if err = json.Unmarshal(raw, &wire); err != nil {
		return out, err
	}
	if wire.TerminalEvidence == nil {
		return out, ErrNotFound
	}
	batch := CounterBatch{InstanceID: instance, EnrollmentEpoch: enrollment, StreamEpoch: stream, Sequence: sequence, Digest: wire.Digest, Samples: wire.Samples, TerminalEvidence: wire.TerminalEvidence}
	if _, err = validateTerminalCounterBatch(batch, raw); err != nil {
		return out, err
	}
	var digest string
	if err = s.readBoundedTerminalReceipt(tx, id, &digest); err != nil {
		return out, err
	}
	if digest != wire.Digest {
		return out, fmt.Errorf("terminal custody receipt mismatch")
	}
	out = TerminalMeterEvidence{ReceiptID: id, StreamEpoch: stream, Sequence: sequence, BatchDigest: digest, CustodyVersion: 1, TerminalEvidence: wire.TerminalEvidence}
	return out, nil
}

// Custody acknowledges closed evidence only after all raw counters are already
// durable. It changes neither counter cursors nor ledger/admission reservations.
func (s *Store) validateTerminalCustodyTx(tx *sql.Tx, batch CounterBatch) error {
	evidence := batch.TerminalEvidence
	if evidence.Final.ObservedAt.After(time.Now().UTC().Add(5 * time.Minute)) {
		return fmt.Errorf("terminal observation time is in the future")
	}
	for _, c := range evidence.Final.Counters {
		sample := CounterSample{CounterEpoch: c.CounterEpoch, SubjectID: c.SubjectID, RouteID: c.RouteID, PolicyRevision: c.PolicyRevision, CycleID: c.CycleID, MeasurementLayer: c.MeasurementLayer}
		var binding MeterBinding
		if err := s.getTx(tx, "meter-bindings", sampleBindingKey(batch.InstanceID, sample), &binding); err != nil {
			return fmt.Errorf("verified terminal meter binding required")
		}
		if binding.LedgerMode != "admission-budget" || binding.UserID != c.AccountID {
			return fmt.Errorf("terminal account or ledger differs from authoritative meter binding")
		}
		var cursor counterCursor
		if err := s.getTx(tx, "counter-cursors", counterKey(batch.InstanceID, sample), &cursor); err != nil {
			return fmt.Errorf("terminal counters require durable prior measurements")
		}
		if cursor.Value != c.CumulativeBytes || cursor.ObservedAt.Before(evidence.Baseline.ObservedAt) || cursor.ObservedAt.After(evidence.Final.ObservedAt) || cursor.PolicyRevision != c.PolicyRevision || cursor.CycleID != c.CycleID {
			return fmt.Errorf("terminal counter differs from durable measurement")
		}
	}
	return nil
}

func (s *Store) readBoundedTerminalReceipt(q terminalQuery, id string, out *string) error {
	var data []byte
	var size int
	bound := 128 + s.aead.NonceSize() + s.aead.Overhead()
	err := q.QueryRow(`SELECT length(data), CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind='meter-receipts' AND id=?`, bound, id).Scan(&size, &data)
	if err == sql.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if size > bound {
		return fmt.Errorf("terminal receipt exceeds byte bound")
	}
	if err = s.open("meter-receipts", id, data, out); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(*out)
	if err != nil || len(decoded) != sha256.Size {
		return fmt.Errorf("invalid terminal custody receipt digest")
	}
	return nil
}
