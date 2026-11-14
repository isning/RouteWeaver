package store_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

type coverageEvidence struct {
	Coverage *struct {
		Version         int        `json:"version"`
		StartedAt       time.Time  `json:"startedAt"`
		LastReceiptAt   *time.Time `json:"lastReceiptAt"`
		FinalReceivedAt *time.Time `json:"finalReceivedAt"`
		FinalSource     string     `json:"finalSource"`
		ClockUncertain  bool       `json:"clockUncertain"`
	} `json:"coverage"`
	LastSettlement time.Time `json:"lastSettlement"`
}

func readCoverage(t *testing.T, s *store.Store, id string) coverageEvidence {
	t.Helper()
	var b coverageEvidence
	if err := s.Get("admission-budgets", id, &b); err != nil {
		t.Fatal(err)
	}
	return b
}
func TestAdmissionCoverageZeroFinalAndReplay(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	in := admissionRequest("entry1", "192.0.2.1", "coverage")
	first, err := s.AcquireAdmission(scope, in, now)
	if err != nil || !first.Allowed {
		t.Fatalf("%+v %v", first, err)
	}
	b := readCoverage(t, s, first.LeaseID)
	if b.Coverage == nil || b.Coverage.Version != 1 || !b.Coverage.StartedAt.Equal(now) || b.Coverage.LastReceiptAt != nil {
		t.Fatalf("issuance is not receipt: %+v", b)
	}
	receipt := now.Add(time.Second)
	if _, err = s.AcquireAdmission(scope, in, receipt); err != nil {
		t.Fatal(err)
	}
	b = readCoverage(t, s, first.LeaseID)
	if b.Coverage.LastReceiptAt == nil || !b.Coverage.LastReceiptAt.Equal(receipt) || !b.LastSettlement.Equal(now) {
		t.Fatalf("zero receipt must not change billing interval: %+v", b)
	}
	in.Final = true
	final := now.Add(2 * time.Second)
	if _, err = s.AcquireAdmission(scope, in, final); err != nil {
		t.Fatal(err)
	}
	b = readCoverage(t, s, first.LeaseID)
	if b.Coverage.FinalReceivedAt == nil || !b.Coverage.FinalReceivedAt.Equal(final) || b.Coverage.FinalSource != "agent" {
		t.Fatalf("missing final: %+v", b)
	}
	if _, err = s.AcquireAdmission(scope, in, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	replay := readCoverage(t, s, first.LeaseID)
	if !replay.Coverage.FinalReceivedAt.Equal(final) || !replay.Coverage.LastReceiptAt.Equal(final) {
		t.Fatal("replay moved closed evidence")
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 0 {
		t.Fatalf("changed zero billing: %+v %v", usage, err)
	}
}
func TestAdmissionCoverageLegacyRemainsUnknown(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	in := admissionRequest("entry1", "192.0.2.1", "legacy")
	first, err := s.AcquireAdmission(scope, in, now)
	if err != nil || !first.Allowed {
		t.Fatal(err)
	}
	var old map[string]json.RawMessage
	if err = s.Get("admission-budgets", first.LeaseID, &old); err != nil {
		t.Fatal(err)
	}
	delete(old, "coverage")
	if err = s.Put("admission-budgets", first.LeaseID, old); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "legacy-restore.db")
	key := make([]byte, 32)
	if err = store.RestoreFresh(context.Background(), target, key, snapshot); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if readCoverage(t, restored, first.LeaseID).Coverage != nil {
		t.Fatal("backup fabricated legacy evidence")
	}
	in.AdmittedBytes = 10
	in.Final = true
	if _, err = s.AcquireAdmission(scope, in, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if readCoverage(t, s, first.LeaseID).Coverage != nil {
		t.Fatal("legacy budget was backfilled")
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 10 {
		t.Fatalf("legacy billing changed: %+v %v", usage, err)
	}
}

func TestAdmissionCoverageClockAndInvalidReceipt(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "clock")
	first, err := s.AcquireAdmission(scope, in, now)
	if err != nil || !first.Allowed {
		t.Fatal(err)
	}
	in.AdmittedBytes = 101
	if _, err = s.AcquireAdmission(scope, in, now.Add(time.Second)); err == nil {
		t.Fatal("invalid receipt accepted")
	}
	if readCoverage(t, s, first.LeaseID).Coverage.LastReceiptAt != nil {
		t.Fatal("invalid receipt became coverage")
	}
	in.AdmittedBytes = 0
	if _, err = s.AcquireAdmission(scope, in, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireAdmission(scope, in, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	b := readCoverage(t, s, first.LeaseID)
	if !b.Coverage.ClockUncertain || !b.Coverage.LastReceiptAt.Equal(now.Add(2*time.Second)) {
		t.Fatal("clock reversal hidden")
	}
}
