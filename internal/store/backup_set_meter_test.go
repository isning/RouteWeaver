package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Synthetic reproduction of transport-history growth, not a wall-clock benchmark.
func TestBackupSetPreservesRawMeterHistoryAndHistoricalExactRetry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{39}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutUser(domain.User{ID: "u", Name: "Synthetic", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "managed-entry-admitted-payload", LedgerMode: "admission-budget"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var batches []store.CounterBatch
	for n := 0; n < 200; n++ {
		b := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "s", Sequence: uint64(n + 1), Digest: fmt.Sprintf("digest-%d", n), Samples: []store.CounterSample{{LedgerMode: "admission-budget", SampleID: fmt.Sprintf("sample-%d", n), CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "managed-entry-admitted-payload", CumulativeBytes: uint64(n * 10), ObservedAt: base.Add(time.Duration(n) * time.Second)}}}
		if err = s.AcceptCounterBatch(b, b); err != nil {
			t.Fatal(err)
		}
		batches = append(batches, b)
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
	setPath := filepath.Join(t.TempDir(), "set")
	limits := backup.SetLimits{TotalBytes: 8 << 20, TotalRows: 2000, PartBytes: 64 << 10, PartRows: 10, RecordBytes: 32 << 10, Parts: 256, Duration: time.Minute, DiskBytes: 256 << 20}
	const password = "synthetic-offline-meter-passphrase"
	if err = backup.CreateSet(context.Background(), s, password, setPath, limits); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	if err = backup.RestoreSet(context.Background(), setPath, password, target, key, limits); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, kind := range []string{"meter-inbox", "meter-receipts", "meter-streams", "ledger"} {
		before, err := s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		after, err := restored.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		a, _ := json.Marshal(before)
		b, _ := json.Marshal(after)
		if !bytes.Equal(a, b) {
			t.Fatalf("raw %s history changed", kind)
		}
	}
	s = restored
	for _, b := range batches {
		if err = s.AcceptCounterBatch(b, b); err != nil {
			t.Fatalf("historical exact replay: %v", err)
		}
		b.Digest += "changed"
		if err = s.AcceptCounterBatch(b, b); err == nil {
			t.Fatal("conflict accepted")
		}
	}
}
