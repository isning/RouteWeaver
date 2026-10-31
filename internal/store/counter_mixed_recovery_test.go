package store_test

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// A pre-upgrade operator could baseline the new counter while skipping an
// existing counter whose interval crosses a policy boundary in the same batch.
func TestCounterAutomaticRecoveryPreservesPartialOperatorResolution(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{30}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	binding := store.MeterBinding{ID: "known-old", InstanceID: "i", SubjectID: "known", UserID: "u", RouteID: "r", PolicyRevision: "old", CycleID: "c", MeasurementLayer: "entry_payload"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	known := store.CounterSample{SampleID: "known", CounterEpoch: "boot", SubjectID: "known", RouteID: "r", PolicyRevision: "old", CycleID: "c", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: now.Add(-2 * time.Minute)}
	installZeroBaseline(t, s, "i", known)
	prior := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "prior", Sequence: 1, Digest: "prior", Samples: []store.CounterSample{known}}
	if err = s.AcceptCounterBatch(prior, prior); err != nil {
		t.Fatal(err)
	}
	binding.ID = "known-new"
	binding.PolicyRevision = "new"
	binding.EffectiveAt = now.Add(-time.Minute)
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	binding.ID = "unknown"
	binding.SubjectID = "unknown"
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	known.PolicyRevision = "new"
	known.CumulativeBytes = 150
	known.ObservedAt = now
	unknown := known
	unknown.SampleID = "unknown"
	unknown.SubjectID = "unknown"
	unknown.CumulativeBytes = 70
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "mixed", Samples: []store.CounterSample{unknown, known}}
	seedLegacyCounterPending(t, s, batch, "u")
	const receiptID = "i:e:main:1"
	operator, err := s.EstablishCounterBaseline("i", receiptID, batch.Digest, "operator", "Start the previously unobserved counter")
	if err != nil || len(operator.Samples) != 1 || operator.Samples[0].SampleID != "unknown" || operator.Samples[0].UnattributedBytes != 70 {
		t.Fatalf("partial legacy resolution %+v %v", operator, err)
	}
	readRaw := func(kind, id string) json.RawMessage {
		t.Helper()
		var raw json.RawMessage
		if err := s.Get(kind, id, &raw); err != nil {
			t.Fatal(err)
		}
		return raw
	}
	oldResolution := readRaw("meter-baseline-resolutions", receiptID)
	oldAudit := readRaw("audit", "meter-baseline:"+receiptID)
	oldHistory := readRaw("meter-pending-history", receiptID)
	for n := 0; n < 2; n++ {
		if err = s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(oldResolution, readRaw("meter-baseline-resolutions", receiptID)) || !bytes.Equal(oldAudit, readRaw("audit", "meter-baseline:"+receiptID)) || !bytes.Equal(oldHistory, readRaw("meter-pending-history", receiptID)) {
			t.Fatal("automatic recovery rewrote legacy resolution, audit or original evidence")
		}
	}
	var automatic store.BaselineResolution
	if err = s.Get("meter-baseline-resolutions", receiptID+":automatic", &automatic); err != nil || automatic.ActorID != "system" || len(automatic.Samples) != 1 || automatic.Samples[0].SampleID != "known" || automatic.Samples[0].UnattributedBytes != 50 {
		t.Fatalf("separate automatic evidence %+v %v", automatic, err)
	}
	var audit store.AuditEvent
	if err = s.Get("audit", "meter-baseline-automatic:"+receiptID, &audit); err != nil || audit.ActorID != "system" || audit.TargetID != receiptID {
		t.Fatalf("separate automatic audit %+v %v", audit, err)
	}
	for _, kind := range []string{"meter-baseline-resolutions", "audit"} {
		if rows, err := s.List(kind); err != nil || len(rows) != 2 {
			t.Fatalf("duplicate or missing %s: %d %v", kind, len(rows), err)
		}
	}
	if usage, err := s.Usage("u", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 100 {
		t.Fatalf("unknown interval charged or known usage changed %+v %v", usage, err)
	}
	if pending, err := s.PendingCounterBatches("i"); err != nil || len(pending) != 0 {
		t.Fatalf("legacy pending retained %+v %v", pending, err)
	}
	if held, err := s.HasAccountingHold("u"); err != nil || held {
		t.Fatalf("recovered hold retained %v %v", held, err)
	}
}
