package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// PendingCounterBatch retains the full encrypted original even after automatic
// recovery. Existing meter-pending rows are consumed by authenticated spool replay.
// Establishing a new baseline never pretends the unobserved prior interval was
// measured in the current cycle or deletes that unresolved historical evidence.
type PendingCounterBatch struct {
	ReceiptID string          `json:"receiptId"`
	Batch     CounterBatch    `json:"batch"`
	Original  json.RawMessage `json:"original"`
	Reason    string          `json:"reason"`
	CreatedAt time.Time       `json:"createdAt"`
}
type BaselineSample struct {
	IntervalStart     time.Time `json:"intervalStart,omitempty"`
	MeasurementLayer  string    `json:"measurementLayer,omitempty"`
	SampleID          string    `json:"sampleId"`
	UserID            string    `json:"userId"`
	CounterEpoch      string    `json:"counterEpoch"`
	UnattributedBytes uint64    `json:"unattributedBytes,string"`
	ObservedAt        time.Time `json:"observedAt"`
}
type BaselineResolution struct {
	InstanceID string           `json:"instanceId"`
	ReceiptID  string           `json:"receiptId"`
	Digest     string           `json:"digest"`
	ActorID    string           `json:"actorId"`
	Reason     string           `json:"reason"`
	At         time.Time        `json:"at"`
	Samples    []BaselineSample `json:"samples"`
}

func counterKey(instance string, sample CounterSample) string {
	return strings.Join([]string{instance, sample.SubjectID, sample.RouteID, sample.MeasurementLayer, sample.CounterEpoch}, ":")
}
func sampleBindingKey(instance string, sample CounterSample) string {
	return bindingKey(MeterBinding{InstanceID: instance, SubjectID: sample.SubjectID, RouteID: sample.RouteID, PolicyRevision: sample.PolicyRevision, CycleID: sample.CycleID, MeasurementLayer: sample.MeasurementLayer})
}
func (s *Store) getTx(tx *sql.Tx, kind, id string, out any) error {
	var raw []byte
	e := tx.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&raw)
	if e == sql.ErrNoRows {
		return ErrNotFound
	}
	if e != nil {
		return e
	}
	return s.open(kind, id, raw, out)
}
func (s *Store) PendingCounterBatches(instance string) ([]PendingCounterBatch, error) {
	raw, e := s.List("meter-pending")
	if e != nil {
		return nil, e
	}
	out := []PendingCounterBatch{}
	for _, b := range raw {
		var v PendingCounterBatch
		if e = json.Unmarshal(b, &v); e != nil {
			return nil, e
		}
		if v.Batch.InstanceID == instance {
			out = append(out, v)
		}
	}
	return out, nil
}

// EstablishCounterBaseline is an explicit operator decision to start measuring
// from an already observed value. It only handles previously unseen epochs, not
// disputed intervals with an existing cursor. No usage or receipt is fabricated:
// the agent must still replay the pending batch and pass normal validation.
func (s *Store) EstablishCounterBaseline(instance, receiptID, digest, actor, reason string) (BaselineResolution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result BaselineResolution
	if strings.TrimSpace(reason) == "" || len(reason) > 1024 || actor == "" {
		return result, fmt.Errorf("an actor and bounded explanation are required")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return result, e
	}
	defer tx.Rollback()
	if e = s.getTx(tx, "meter-baseline-resolutions", receiptID, &result); e == nil {
		if result.InstanceID != instance || result.Digest != digest || result.ActorID != actor || result.Reason != reason {
			return BaselineResolution{}, ErrConflict
		}
		return result, nil
	} else if e != ErrNotFound {
		return result, e
	}
	var pending PendingCounterBatch
	if e = s.getTx(tx, "meter-pending", receiptID, &pending); e != nil {
		return result, e
	}
	if pending.Batch.InstanceID != instance || pending.Batch.Digest != digest {
		return result, ErrConflict
	}
	result = BaselineResolution{InstanceID: instance, ReceiptID: receiptID, Digest: digest, ActorID: actor, Reason: reason, At: time.Now().UTC(), Samples: []BaselineSample{}}
	for _, sample := range pending.Batch.Samples {
		var previous counterCursor
		e = s.getTx(tx, "counter-cursors", counterKey(instance, sample), &previous)
		if e == nil {
			continue
		}
		if e != ErrNotFound {
			return BaselineResolution{}, e
		}
		if sample.CumulativeBytes == 0 {
			continue
		}
		var binding MeterBinding
		if e = s.getTx(tx, "meter-bindings", sampleBindingKey(instance, sample), &binding); e != nil {
			return BaselineResolution{}, e
		}
		cursor := counterCursor{Value: sample.CumulativeBytes, ObservedAt: sample.ObservedAt, PolicyRevision: sample.PolicyRevision, CycleID: sample.CycleID, RateID: binding.RateID}
		if e = s.putTx(tx, "counter-cursors", counterKey(instance, sample), cursor); e != nil {
			return BaselineResolution{}, e
		}
		result.Samples = append(result.Samples, BaselineSample{SampleID: sample.SampleID, UserID: binding.UserID, CounterEpoch: sample.CounterEpoch, UnattributedBytes: sample.CumulativeBytes, ObservedAt: sample.ObservedAt})
	}
	if len(result.Samples) == 0 {
		return BaselineResolution{}, fmt.Errorf("pending interval already has a baseline; exact boundary evidence is required")
	}
	if e = s.putTx(tx, "meter-baseline-resolutions", receiptID, result); e != nil {
		return BaselineResolution{}, e
	}
	audit := AuditEvent{ID: "meter-baseline:" + receiptID, ActorID: actor, Action: "establish-meter-baseline-without-retroactive-charge", TargetID: receiptID, At: result.At}
	if e = s.putTx(tx, "audit", audit.ID, audit); e != nil {
		return BaselineResolution{}, e
	}
	return result, tx.Commit()
}
