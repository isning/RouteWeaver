package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Synthetic reproduction of transport-history growth, not a wall-clock benchmark.
func TestMeterTransportHistoryGrowthRepro(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{39}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	if err = s.PutUser(domain.User{ID: "u", Name: "Synthetic", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "managed-entry-admitted-payload", LedgerMode: "admission-budget"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var first, last store.CounterBatch
	for n := 0; n < 200; n++ {
		b := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "s", Sequence: uint64(n + 1), Digest: fmt.Sprintf("digest-%d", n), Samples: []store.CounterSample{{LedgerMode: "admission-budget", SampleID: fmt.Sprintf("sample-%d", n), CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "managed-entry-admitted-payload", CumulativeBytes: uint64(n * 10), ObservedAt: base.Add(time.Duration(n) * time.Second)}}}
		if err = s.AcceptCounterBatch(b, b); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			first = b
		}
		last = b
	}
	for _, kind := range []string{"meter-inbox", "meter-receipts", "meter-streams", "ledger"} {
		rows, err := s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		total := 0
		for _, r := range rows {
			total += len(r)
		}
		t.Logf("%s rows=%d logical_bytes=%d", kind, len(rows), total)
		want := 200
		if kind == "meter-streams" {
			want = 1
		}
		if kind == "ledger" {
			want = 0
		}
		if len(rows) != want {
			t.Fatalf("%s rows %d != %d", kind, len(rows), want)
		}
	}
	frames, size := 0, 0
	err = s.ExportBackup(context.Background(), store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}, func(f store.BackupFrame) error { frames++; b, e := json.Marshal(f); size += len(b) + 1; return e })
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("backup frames=%d serialized_frame_bytes=%d", frames, size)
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range []store.CounterBatch{first, last} {
		if err = s.AcceptCounterBatch(b, b); err != nil {
			t.Fatalf("historical exact replay: %v", err)
		}
		b.Digest += "changed"
		if err = s.AcceptCounterBatch(b, b); err == nil {
			t.Fatal("conflict accepted")
		}
	}
}
