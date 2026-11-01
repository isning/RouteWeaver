package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestNotificationPagesRotateAcrossDisabledDeletedAndNewUsers(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{68}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 7; i++ {
		id := fmt.Sprintf("u%03d", i)
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: i != 1}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	page, err := s.NotificationInputPage(context.Background(), "", 3, now)
	if err != nil || page.Next != "u002" || len(page.Recipients) != 4 || len(page.Users) != 2 {
		t.Fatalf("first page/cursor: %+v %v", page, err)
	}
	if err = s.Remove("users", "u002"); err != nil {
		t.Fatal(err)
	}
	if err = s.PutUser(domain.User{ID: "u001a", Name: "New behind cursor", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	page, err = s.NotificationInputPage(context.Background(), page.Next, 3, now)
	if err != nil || page.Next != "u005" || len(page.Users) != 3 || page.Users[0].UserID != "u003" {
		t.Fatalf("deleted cursor/new lower ID broke rotation: %+v %v", page, err)
	}
	page, err = s.NotificationInputPage(context.Background(), page.Next, 3, now)
	if err != nil || page.Next != "" || len(page.Users) != 1 || page.Users[0].UserID != "u006" {
		t.Fatalf("last page failed wrap: %+v %v", page, err)
	}
	page, err = s.NotificationInputPage(context.Background(), page.Next, 3, now)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, u := range page.Users {
		found = found || u.UserID == "u001a"
	}
	if !found {
		t.Fatal("new lower ID starved after wrap")
	}
}

func TestNotificationColdPageSharesOneLedgerPassAndRefusesOversizedColdRead(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{69}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for _, id := range []string{"alice", "bob"} {
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: true}); err != nil {
			t.Fatal(err)
		}
		if err = s.Put("ledger", id, MeterRecord{MeterBatch: MeterBatch{UserID: id, RawBytes: 2, ObservedAt: now}, RateMicros: 1000000}); err != nil {
			t.Fatal(err)
		}
	}
	observer := installNotificationReadObserver(t, s)
	page, err := s.NotificationInputPage(context.Background(), "", 100, now)
	if err != nil || len(page.Users) != 2 {
		t.Fatalf("cold page: %+v %v", page, err)
	}
	if q, r := observer.Counts(); q != 2 || r != 4 {
		t.Fatalf("per-user cold scans replaced shared pass: queries=%d rows=%d", q, r)
	}
	// A bypassed invalid large record dirties the canonical generation. Refusal
	// happens from bounded SQL length metadata, before allocating/decrypting it.
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','oversized',zeroblob(?))`, notificationColdRecordBytes+1); err != nil {
		t.Fatal(err)
	}
	var generation, ack int64
	if err = s.db.QueryRow(`SELECT generation,acknowledged FROM usage_projection_state WHERE id=1`).Scan(&generation, &ack); err != nil {
		t.Fatal(err)
	}
	observer.Reset()
	page, err = s.NotificationInputPage(context.Background(), "", 100, now)
	if !errors.Is(err, ErrNotificationColdBudget) || len(page.Users) != 2 || !page.Users[0].UsageUnknown || !page.Users[1].UsageUnknown {
		t.Fatalf("cold budget did not fail closed: %+v %v", page, err)
	}
	if q, r := observer.Counts(); q != 1 || r != 3 {
		t.Fatalf("cold refusal fetched ledger bodies: queries=%d rows=%d", q, r)
	}
	var afterGeneration, afterAck int64
	if err = s.db.QueryRow(`SELECT generation,acknowledged FROM usage_projection_state WHERE id=1`).Scan(&afterGeneration, &afterAck); err != nil {
		t.Fatal(err)
	}
	if generation != afterGeneration || ack != afterAck {
		t.Fatal("failed cold rebuild acknowledged dirty partial projection")
	}
}

func TestNotificationBudgetIncludesWaitingForStoreMutex(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{70}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.NotificationInputPage(ctx, "", 100, time.Now()); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("wrong lock cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled notification page waited indefinitely for Store mutex")
	}
}

func TestNotificationColdBudgetDoesNotSuppressWarmAccounts(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{71}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err = s.PutUser(domain.User{ID: "alice", Name: "Alice", Enabled: true, QuotaBytes: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.NotificationInputPage(context.Background(), "", 100, now); err != nil {
		t.Fatal(err)
	}
	if err = s.PutUser(domain.User{ID: "bob", Name: "New cold account", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"userId": "elsewhere", "rawBytes": 1, "rateMicros": 1000000, "observedAt": now, "padding": string(bytes.Repeat([]byte{'x'}, notificationColdRecordBytes))})
	if err = s.Put("ledger", "large-but-tracked", json.RawMessage(raw)); err != nil {
		t.Fatal(err)
	}
	page, err := s.NotificationInputPage(context.Background(), "", 100, now)
	if !errors.Is(err, ErrNotificationColdBudget) || len(page.Users) != 2 || page.Users[0].UserID != "alice" || page.Users[0].UsageUnknown || !page.Users[1].UsageUnknown {
		t.Fatalf("new cold account suppressed verified warm peer: %+v %v", page, err)
	}
}

func TestNotificationColdCancellationRollsBackPartialWindows(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err = s.PutUser(domain.User{ID: "alice", Name: "Alice", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if err = s.Put("ledger", id, MeterRecord{MeterBatch: MeterBatch{UserID: "alice", RawBytes: 1, ObservedAt: now}, RateMicros: 1000000}); err != nil {
			t.Fatal(err)
		}
	}
	observer := installNotificationReadObserver(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer.afterLedgerRow = func(rows int64) {
		if rows == 2 {
			cancel()
		}
	}
	page, err := s.NotificationInputPage(ctx, "", 100, now)
	if !errors.Is(err, context.Canceled) || len(page.Users) != 0 {
		t.Fatalf("cancelled partial rebuild published snapshot: %+v %v", page, err)
	}
	var count int
	if err = s.db.QueryRow(`SELECT count(*) FROM usage_windows`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("cancelled rebuild committed partial projection: %d %v", count, err)
	}
	observer.afterLedgerRow = nil
	page, err = s.NotificationInputPage(context.Background(), "", 100, now)
	if err != nil || len(page.Users) != 1 || page.Users[0].UsedBytes != 3 {
		t.Fatalf("retry after cancellation: %+v %v", page, err)
	}
}

func TestNotificationCurrentRecipientsScaleDoesNotReadHistoricalLedger(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{75}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	writes := make([]RecordWrite, 0, 500)
	for i := 0; i < 500; i++ {
		id := fmt.Sprintf("user-%03d", i)
		writes = append(writes, RecordWrite{Kind: "users", ID: id, Value: domain.User{ID: id, Name: id, Enabled: i%10 != 0}})
	}
	if err = s.UpdateRecords("unused", "unused", func(json.RawMessage) ([]RecordWrite, error) { return writes, nil }); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "unrelated-history", json.RawMessage(`{"userId":123}`)); err != nil {
		t.Fatal(err)
	}
	observer := installNotificationReadObserver(t, s)
	recipients, err := s.NotificationRecipients(context.Background())
	if err != nil || len(recipients) != 501 {
		t.Fatalf("current recipient enumeration: %d %v", len(recipients), err)
	}
	disabled := 0
	for _, r := range recipients {
		if !r.Enabled {
			disabled++
		}
	}
	if disabled != 50 {
		t.Fatalf("disabled current identity lost: %d", disabled)
	}
	if q, r := observer.Counts(); q != 0 || r != 0 {
		t.Fatalf("current recipients touched ledger history: queries=%d rows=%d", q, r)
	}
}

func TestNotificationSQLWriterWaitHonorsContextBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, err := Open(path, bytes.Repeat([]byte{76}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	writer, err := other.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err = writer.Exec(`UPDATE counters SET value=value`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = s.NotificationInputPage(ctx, "", 100, time.Now())
	elapsed := time.Since(started)
	if !errors.Is(err, context.DeadlineExceeded) || elapsed > time.Second {
		t.Fatalf("SQL writer wait ignored notification deadline: elapsed=%s error=%v", elapsed, err)
	}
}

func TestNotificationInjectedColdRowBudgetCommitsOnlyBoundedPrefix(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{83}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	if err = s.PutUser(domain.User{ID: "alice", Name: "Alice", Enabled: true, QuotaBytes: 1}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if err = s.Put("ledger", id, MeterRecord{MeterBatch: MeterBatch{UserID: "alice", RawBytes: 100, ObservedAt: now}, RateMicros: 1000000}); err != nil {
			t.Fatal(err)
		}
	}
	observer := installNotificationReadObserver(t, s)
	page, err := s.NotificationInputPageWithBudget(context.Background(), "", 100, now, NotificationColdBudget{Rows: 1, Bytes: 1024})
	if !errors.Is(err, ErrNotificationRebuildPending) || len(page.Users) != 1 || !page.Users[0].UsageUnknown {
		t.Fatalf("budget result %+v %v", page, err)
	}
	if queries, rows := observer.Counts(); queries != 2 || rows != 3 {
		t.Fatalf("budget exceeded one canonical body plus bounded metadata: queries=%d rows=%d", queries, rows)
	}
}
