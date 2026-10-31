package store

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestWarmNotificationInputsDoNotReadCanonicalLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{64}, 32)
	s, err := Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err = s.PutUser(domain.User{ID: "alice", Name: "Alice", Enabled: true, QuotaBytes: 100}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for _, id := range []string{"a", "b", "c"} {
		if err = s.Put("ledger", id, MeterRecord{MeterBatch: MeterBatch{UserID: "alice", RawBytes: 1, ObservedAt: now}, RateMicros: 1000000}); err != nil {
			t.Fatal(err)
		}
	}
	observer := installNotificationReadObserver(t, s)
	_, users, err := s.NotificationInputs(now)
	if err != nil || len(users) != 1 || users[0].UsedBytes != 3 {
		t.Fatalf("cold snapshot: %+v %v", users, err)
	}
	if queries, rows := observer.Counts(); queries != 2 || rows != 4 {
		t.Fatalf("cold observer did not see exactly one metadata+ledger pass: queries=%d rows=%d", queries, rows)
	}
	observer.Reset()
	_, users, err = s.NotificationInputs(now.Add(time.Minute))
	if err != nil || users[0].UsedBytes != 3 {
		t.Fatalf("warm snapshot: %+v %v", users, err)
	}
	if queries, rows := observer.Counts(); queries != 0 || rows != 0 {
		t.Fatalf("warm notification evaluation rescanned canonical ledger: queries=%d rows=%d", queries, rows)
	}
	if err = other.Put("ledger", "d", MeterRecord{MeterBatch: MeterBatch{UserID: "alice", RawBytes: 1, ObservedAt: now}, RateMicros: 1000000}); err != nil {
		t.Fatal(err)
	}
	observer.Reset()
	_, users, err = s.NotificationInputs(now.Add(2 * time.Minute))
	if err != nil || users[0].UsedBytes != 4 {
		t.Fatalf("incremental cross-handle snapshot: %+v %v", users, err)
	}
	if queries, rows := observer.Counts(); queries != 0 || rows != 0 {
		t.Fatalf("incremental warm snapshot scanned ledger: queries=%d rows=%d", queries, rows)
	}
}
