package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/service"
	"strings"
	"time"
)

// MeterBinding is an immutable administrator assertion connecting one verified
// measurement source to a user/route/policy/cycle. Provider counters never become
// user payload merely because they are on the same host.
type MeterBinding struct {
	LedgerMode       string    `json:"ledgerMode,omitempty"`
	ID               string    `json:"id"`
	InstanceID       string    `json:"instanceId"`
	SubjectID        string    `json:"subjectId"`
	UserID           string    `json:"userId"`
	RouteID          string    `json:"routeId"`
	PolicyRevision   string    `json:"policyRevision"`
	CycleID          string    `json:"cycleId"`
	MeasurementLayer string    `json:"measurementLayer"`
	RateID           string    `json:"rateId"`
	EffectiveAt      time.Time `json:"effectiveAt"`
}
type CounterSample struct {
	LedgerMode       string    `json:"ledgerMode,omitempty"`
	SampleID         string    `json:"sampleId"`
	CounterEpoch     string    `json:"counterEpoch"`
	SubjectID        string    `json:"subjectId"`
	RouteID          string    `json:"routeId"`
	PolicyRevision   string    `json:"policyRevision"`
	CycleID          string    `json:"cycleId"`
	MeasurementLayer string    `json:"measurementLayer"`
	CumulativeBytes  uint64    `json:"cumulativeBytes,string"`
	ObservedAt       time.Time `json:"observedAt"`
}
type CounterBatch struct {
	TerminalEvidence *entrypolicy.TerminalEvidence `json:"terminalEvidence,omitempty"`
	InstanceID       string                        `json:"instanceId"`
	EnrollmentEpoch  string                        `json:"enrollmentEpoch"`
	StreamEpoch      string                        `json:"streamEpoch"`
	Digest           string                        `json:"digest"`
	Sequence         uint64                        `json:"sequence,string"`
	Samples          []CounterSample               `json:"samples"`
}

// ErrPendingAttribution describes persisted legacy pending records. New valid
// observations recover automatically; invalid evidence still fails closed.
var ErrPendingAttribution = errors.New("counter interval has no proven baseline or crosses a policy or cycle boundary; boundary evidence required")

type AccountingHold struct {
	UserID    string    `json:"userId"`
	ReceiptID string    `json:"receiptId"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"createdAt"`
}
type counterCursor struct {
	PolicyRevision string    `json:"policyRevision"`
	CycleID        string    `json:"cycleId"`
	RateID         string    `json:"rateId"`
	Value          uint64    `json:"value,string"`
	ObservedAt     time.Time `json:"observedAt"`
}
type streamCursor struct {
	Sequence uint64 `json:"sequence,string"`
}

func bindingKey(v MeterBinding) string {
	return strings.Join([]string{v.InstanceID, v.SubjectID, v.RouteID, v.PolicyRevision, v.CycleID, v.MeasurementLayer}, ":")
}
func (s *Store) SetMeterBinding(v MeterBinding) error {
	record, e := MeterBindingRecord(v)
	if e != nil {
		return e
	}
	var u domain.User
	if e := s.Get("users", v.UserID, &u); e != nil {
		return e
	}
	return s.PutImmutable(record.Kind, record.ID, record.Value)
}

// AcceptCounterBatch converts cumulative counters to deltas exactly once and
// atomically persists cursors, frozen-rate ledger rows, original inbox and receipt.
// Unknown bindings, sequence gaps, or an implicit counter reset reject the entire
// batch. The caller must verify the wire digest and enrollment before calling.
func (s *Store) AcceptCounterBatch(batch CounterBatch, original any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if batch.Sequence == 0 || (len(batch.Samples) == 0 && batch.TerminalEvidence == nil) || len(batch.Samples) > 1000 {
		return fmt.Errorf("invalid counter batch")
	}
	terminalRaw, err := validateTerminalCounterBatch(batch, original)
	if err != nil {
		return err
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	get := func(kind, id string, out any) error {
		var b []byte
		e := tx.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&b)
		if e == sql.ErrNoRows {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		return s.open(kind, id, b, out)
	}
	put := func(kind, id string, value any) error {
		return s.putTx(tx, kind, id, value)
	}
	stream := strings.Join([]string{batch.InstanceID, batch.EnrollmentEpoch, batch.StreamEpoch}, ":")
	receiptID := fmt.Sprintf("%s:%d", stream, batch.Sequence)
	var digest string
	if batch.TerminalEvidence != nil {
		e = s.readBoundedTerminalReceipt(tx, receiptID, &digest)
	} else {
		e = get("meter-receipts", receiptID, &digest)
	}
	if e == nil {
		if digest != batch.Digest {
			return fmt.Errorf("conflicting meter replay")
		}
		if batch.TerminalEvidence != nil {
			var retained json.RawMessage
			if e = s.readBoundedTerminalInbox(tx, receiptID, &retained); e != nil {
				return e
			}
			if !bytes.Equal(retained, terminalRaw) {
				return fmt.Errorf("terminal replay differs from retained custody evidence")
			}
		}
		return nil
	} else if e != ErrNotFound {
		return e
	}
	var pending PendingCounterBatch
	if e = get("meter-pending", receiptID, &pending); e == nil {
		if pending.Batch.Digest != batch.Digest {
			return fmt.Errorf("conflicting pending meter replay")
		}
	} else if e != ErrNotFound {
		return e
	}
	var sequence streamCursor
	if e = get("meter-streams", stream, &sequence); e != nil && e != ErrNotFound {
		return e
	}
	if batch.Sequence != sequence.Sequence+1 {
		return fmt.Errorf("meter sequence gap; replay the oldest unacknowledged batch")
	}
	if batch.TerminalEvidence != nil {
		if e = s.validateTerminalCustodyTx(tx, batch); e != nil {
			return e
		}
		if e = put("meter-streams", stream, streamCursor{Sequence: batch.Sequence}); e != nil {
			return e
		}
		if e = put("meter-inbox", receiptID, original); e != nil {
			return e
		}
		if e = put("meter-receipts", receiptID, batch.Digest); e != nil {
			return e
		}
		return tx.Commit()
	}
	rates := []service.Rate{}
	rows, e := tx.Query(`SELECT id,data FROM records WHERE kind='rates'`)
	if e != nil {
		return e
	}
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			rows.Close()
			return e
		}
		var rate service.Rate
		if e = s.open("rates", id, b, &rate); e != nil {
			rows.Close()
			return e
		}
		rates = append(rates, rate)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	// Manual resets are an accounting boundary too. Read their immutable history
	// in this same transaction, not after committing a possibly misattributed delta.
	resets := []Reset{}
	rows, e = tx.Query(`SELECT id,data FROM records WHERE kind='resets'`)
	if e != nil {
		return e
	}
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			rows.Close()
			return e
		}
		var reset Reset
		if e = s.open("resets", id, b, &reset); e != nil {
			rows.Close()
			return e
		}
		resets = append(resets, reset)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	seen := map[string]bool{}
	now := time.Now().UTC()
	resolution := BaselineResolution{InstanceID: batch.InstanceID, ReceiptID: receiptID, Digest: batch.Digest, ActorID: "system", Reason: "Automatically continue from observed counters; unknown historical intervals are retained without retroactive charge", At: now}
	for i, sample := range batch.Samples {
		if !domain.ValidID(sample.SampleID) || !domain.ValidID(sample.CounterEpoch) || sample.ObservedAt.IsZero() || sample.ObservedAt.After(now.Add(5*time.Minute)) {
			return fmt.Errorf("invalid counter sample identity or time")
		}
		if seen[sample.SampleID] {
			return fmt.Errorf("duplicate sample id in batch")
		}
		seen[sample.SampleID] = true
		key := sampleBindingKey(batch.InstanceID, sample)
		var binding MeterBinding
		if e = get("meter-bindings", key, &binding); e != nil {
			return fmt.Errorf("verified meter binding required before accounting")
		}
		if sample.LedgerMode != binding.LedgerMode && !(sample.LedgerMode == "counter" && binding.LedgerMode == "") {
			return fmt.Errorf("meter ledger mode differs from authoritative binding")
		}
		cursorKey := counterKey(batch.InstanceID, sample)
		var previous counterCursor
		if e = get("counter-cursors", cursorKey, &previous); e != nil && e != ErrNotFound {
			return e
		}
		if sample.CumulativeBytes < previous.Value {
			return fmt.Errorf("counter decreased without a new explicit counter epoch")
		}
		delta := sample.CumulativeBytes - previous.Value
		if delta > math.MaxInt64 {
			return fmt.Errorf("counter delta exceeds accounting range")
		}
		if sample.ObservedAt.Before(previous.ObservedAt) {
			return fmt.Errorf("counter observation order is inconsistent")
		}
		unproven := delta > 0 && previous.ObservedAt.IsZero()
		if delta > 0 && !previous.ObservedAt.IsZero() {
			if (previous.PolicyRevision != sample.PolicyRevision || previous.CycleID != sample.CycleID || previous.RateID != binding.RateID) && (binding.EffectiveAt.IsZero() || !previous.ObservedAt.Equal(binding.EffectiveAt)) {
				unproven = true
			}
			// Cumulative observations delimit [previous, current). A reading taken
			// exactly at a boundary proves the old interval, not the new cycle.
			if sample.ObservedAt.After(previous.ObservedAt) {
				end := sample.ObservedAt.Add(-time.Nanosecond)
				var entitlement service.Entitlement
				if e = get("entitlements", binding.UserID, &entitlement); e == nil {
					startWindow, err := entitlement.Cycle.Window(previous.ObservedAt)
					if err != nil {
						return err
					}
					endWindow, err := entitlement.Cycle.Window(end)
					if err != nil {
						return err
					}
					if !startWindow.Start.Equal(endWindow.Start) {
						unproven = true
					}
				} else if e != ErrNotFound {
					return e
				}
				for _, reset := range resets {
					if reset.UserID == binding.UserID && reset.At.After(previous.ObservedAt) && !reset.At.After(end) {
						unproven = true
					}
				}
			}
		}
		if unproven && binding.LedgerMode != "admission-budget" {
			// This is a real observation, not an invented zero or a guessed split.
			// Preserve the unknown interval, then account only subsequent deltas.
			// All validation and evidence writes still commit with the receipt.
			resolution.Samples = append(resolution.Samples, BaselineSample{SampleID: sample.SampleID, UserID: binding.UserID, CounterEpoch: sample.CounterEpoch, UnattributedBytes: delta, ObservedAt: sample.ObservedAt, IntervalStart: previous.ObservedAt, MeasurementLayer: sample.MeasurementLayer})
			delta = 0
		}

		meter := MeterBatch{UserID: binding.UserID, RouteID: binding.RouteID, MeterID: binding.ID, Epoch: sample.CounterEpoch, Sequence: batch.Sequence, ObservedAt: sample.ObservedAt}
		rate := service.Rate{ID: "default-1x", Micros: service.RateScale}
		if binding.MeasurementLayer == "entry_payload" || binding.MeasurementLayer == entrypolicy.MeasurementLayer {
			meter.RawBytes = int64(delta)
			if binding.RateID != "" && binding.RateID != "default-1x" {
				found := false
				for _, r := range rates {
					if r.ID == binding.RateID && r.RouteID == binding.RouteID {
						rate = r
						found = true
					}
				}
				if !found {
					return fmt.Errorf("bound immutable rate revision is missing")
				}
			}
		} else {
			meter.ProviderBytes = int64(delta)
			rate = service.Rate{ID: "provider-separate", Micros: 0}
		}
		weighted, e := service.WeightedBytes(meter.RawBytes, rate.Micros)
		if e != nil {
			return e
		}
		if !previous.ObservedAt.IsZero() && sample.ObservedAt.After(previous.ObservedAt) {
			meter.ObservedAt = sample.ObservedAt.Add(-time.Nanosecond)
		}
		record := MeterRecord{MeterBatch: meter, WeightedBytes: weighted, RateID: rate.ID, RateMicros: rate.Micros, RecordedAt: now, IntervalStart: previous.ObservedAt, IntervalEnd: sample.ObservedAt}
		ledgerID := fmt.Sprintf("counter:%s:%d", receiptID, i)
		if binding.LedgerMode != "admission-budget" {
			if e = put("ledger", ledgerID, record); e != nil {
				return e
			}
		}
		if e = put("counter-cursors", cursorKey, counterCursor{Value: sample.CumulativeBytes, ObservedAt: sample.ObservedAt, PolicyRevision: sample.PolicyRevision, CycleID: sample.CycleID, RateID: binding.RateID}); e != nil {
			return e
		}
	}
	if len(resolution.Samples) > 0 {
		var history PendingCounterBatch
		if e = get("meter-pending-history", receiptID, &history); e == ErrNotFound {
			raw, err := json.Marshal(original)
			if err != nil {
				return err
			}
			history = PendingCounterBatch{ReceiptID: receiptID, Batch: batch, Original: raw, Reason: resolution.Reason, CreatedAt: now}
			if e = put("meter-pending-history", receiptID, history); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		resolutionID := receiptID
		var priorResolution BaselineResolution
		if e = get("meter-baseline-resolutions", receiptID, &priorResolution); e == nil {
			// Preserve a pre-upgrade operator resolution when a different sample
			// in the same batch still needs automatic boundary recovery.
			resolutionID += ":automatic"
		} else if e != ErrNotFound {
			return e
		}
		if e = put("meter-baseline-resolutions", resolutionID, resolution); e != nil {
			return e
		}
		audit := AuditEvent{ID: "meter-baseline-automatic:" + receiptID, ActorID: "system", Action: "automatically-establish-meter-baseline-without-retroactive-charge", TargetID: receiptID, At: now}
		if e = put("audit", audit.ID, audit); e != nil {
			return e
		}
	}
	if _, e = s.deleteTx(tx, "meter-pending", receiptID); e != nil {
		return e
	}
	holds, e := tx.Query(`SELECT id,data FROM records WHERE kind='accounting-holds'`)
	if e != nil {
		return e
	}
	clear := []string{}
	for holds.Next() {
		var id string
		var b []byte
		if e = holds.Scan(&id, &b); e != nil {
			holds.Close()
			return e
		}
		var hold AccountingHold
		if e = s.open("accounting-holds", id, b, &hold); e != nil {
			holds.Close()
			return e
		}
		if hold.ReceiptID == receiptID {
			clear = append(clear, id)
		}
	}
	e = holds.Err()
	holds.Close()
	if e != nil {
		return e
	}
	for _, id := range clear {
		if _, e = s.deleteTx(tx, "accounting-holds", id); e != nil {
			return e
		}
	}
	if e = put("meter-streams", stream, streamCursor{Sequence: batch.Sequence}); e != nil {
		return e
	}
	if e = put("meter-inbox", receiptID, original); e != nil {
		return e
	}
	if e = put("meter-receipts", receiptID, batch.Digest); e != nil {
		return e
	}
	return tx.Commit()
}

func (s *Store) HasAccountingHold(user string) (bool, error) {
	all, e := s.List("accounting-holds")
	if e != nil {
		return false, e
	}
	for _, b := range all {
		var h AccountingHold
		if e = json.Unmarshal(b, &h); e != nil {
			return false, e
		}
		if h.UserID == user {
			return true, nil
		}
	}
	return s.unresolvedBudgetHold(user, time.Now().UTC())
}
