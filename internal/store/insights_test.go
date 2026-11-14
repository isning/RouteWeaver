package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestInsightsExactBucketsIsolationAndBoundaries(t *testing.T) {
	s, now := rebuildFixture(t)
	now = time.Date(2026, 11, 14, 17, 0, 0, 0, time.UTC) // Nov 15 in UTC+8.
	put := func(id, user, route string, raw, rate int64, at time.Time) {
		t.Helper()
		v := rebuildRecord(user, raw, rate, at)
		v.RouteID = route
		if e := s.Put("ledger", id, v); e != nil {
			t.Fatal(e)
		}
	}
	put("a", "u", "r1", 1, 500000, now)
	put("b", "u", "r1", 1, 500000, now)
	put("c", "u", "r2", 4, 2000000, now.Add(-2*time.Hour)) // previous local day
	put("old", "u", "r2", 9, 1000000, now.AddDate(0, 0, -20))
	put("future", "u", "r2", 99, 1000000, now.Add(time.Second))
	put("foreign", "other", "private-route", 999, 1000000, now)
	v, e := s.UsageInsightsContext(context.Background(), "u", now.Add(-time.Hour), now)
	if e != nil {
		t.Fatal(e)
	}
	if len(v.Daily) != 14 || v.Daily[13].Date != "2026-11-15" || v.Daily[13].RawBytes != 2 || v.Daily[13].WeightedBytes != 1 || v.Daily[12].RawBytes != 4 || v.Daily[12].WeightedBytes != 8 {
		t.Fatalf("buckets: %+v", v)
	}
	if len(v.Routes) != 1 || v.Routes[0].RouteID != "r1" || v.Routes[0].RawBytes != 2 || v.Routes[0].WeightedBytes != 1 {
		t.Fatalf("cycle/reset isolation: %+v", v.Routes)
	}
	if e = s.PutUser(domain.User{ID: "empty", Name: "Empty", Enabled: true}); e != nil {
		t.Fatal(e)
	}
	empty, e := s.UsageInsightsContext(context.Background(), "empty", time.Time{}, now)
	if e != nil || len(empty.Daily) != 14 || len(empty.Routes) != 0 || len(empty.Admission.OnlineIPs) != 0 {
		t.Fatalf("empty: %+v %v", empty, e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = s.UsageInsightsContext(ctx, "u", time.Time{}, now); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancel: %v", e)
	}
	// An authenticated count that contradicts returned membership is not trusted.
	tx, e := s.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if e = s.writeUsageHistoryCountTx(tx, s.usageHistoryToken("u"), 0); e != nil {
		t.Fatal(e)
	}
	var generation int64
	if e = tx.QueryRow(`SELECT generation FROM usage_projection_state WHERE id=1`).Scan(&generation); e != nil {
		t.Fatal(e)
	}
	if e = s.writeUsageHistoryStampTx(tx, generation); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	if _, e = s.UsageInsightsContext(context.Background(), "u", time.Time{}, now); !errors.Is(e, ErrInsightsUnavailable) {
		t.Fatalf("inconsistent count: %v", e)
	}
}

func TestInsightsRejectsUntrustedHistory(t *testing.T) {
	s, now := rebuildFixture(t)
	if e := s.Put("ledger", "a", rebuildRecord("u", 4, 1000000, now)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec(`DELETE FROM usage_history`); e != nil {
		t.Fatal(e)
	}
	if _, e := s.UsageInsightsContext(context.Background(), "u", time.Time{}, now); !errors.Is(e, ErrInsightsUnavailable) {
		t.Fatalf("false empty: %v", e)
	}
}

func TestInsightsTimeIndexAndAdmissionAvailability(t *testing.T) {
	s, now := rebuildFixture(t)
	// The selected recent window must not include older canonical records.
	old := rebuildRecord("u", 9, 1000000, now.AddDate(0, 0, -30))
	if e := s.Put("ledger", "old", old); e != nil {
		t.Fatal(e)
	}
	recent := rebuildRecord("u", 3, 1000000, now)
	recent.RouteID = "route"
	if e := s.Put("ledger", "recent", recent); e != nil {
		t.Fatal(e)
	}
	v, e := s.UsageInsightsContext(context.Background(), "u", now.AddDate(0, 0, -2), now)
	if e != nil || len(v.Routes) != 1 || v.Routes[0].RawBytes != 3 || !v.Admission.Available {
		t.Fatalf("recent %+v %v", v, e)
	}
	if _, e = s.db.Exec(`UPDATE usage_history SET observed_second=observed_second-99999999 WHERE id='recent'`); e != nil {
		t.Fatal(e)
	}
	if _, e = s.UsageInsightsContext(context.Background(), "u", now.AddDate(0, 0, -2), now); !errors.Is(e, ErrInsightsUnavailable) {
		t.Fatalf("time predicate tamper hid usage: %v", e)
	}
}

func TestInsightsLargeHistoricalWindowAndLeaseProjection(t *testing.T) {
	s, now := rebuildFixture(t)
	tx, e := s.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i <= insightsRowLimit; i++ {
		id := fmt.Sprintf("old-%05d", i)
		raw, e := s.seal("ledger", id, rebuildRecord("u", 1, 1000000, now.AddDate(0, 0, -30)))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger',?,?)`, id, raw); e != nil {
			t.Fatal(e)
		}
		lease := admissionLease{ID: id, Binding: EntryAdmissionBinding{UserID: "other"}, ClientIP: "192.0.2.9", ExpiresAt: now.Add(-time.Hour)}
		raw, e = s.seal("entry-admission-leases", id, lease)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(`INSERT INTO records(kind,id,data) VALUES('entry-admission-leases',?,?)`, id, raw); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	if e = s.initializeUsageProjection(); e != nil {
		t.Fatal(e)
	}
	v, e := s.UsageInsightsContext(context.Background(), "u", now.AddDate(0, 0, -2), now)
	if e != nil || len(v.Daily) != 14 || len(v.Routes) != 0 || v.Admission.Available {
		t.Fatalf("old history must not disable recent usage; cold admission explicitly unavailable: %+v %v", v, e)
	}
	if _, e = s.UsageInsightsContext(context.Background(), "u", time.Time{}, now); !errors.Is(e, ErrInsightsUnavailable) {
		t.Fatalf("selected oversized period: %v", e)
	}
	lease := admissionLease{ID: "live", Binding: EntryAdmissionBinding{UserID: "u"}, ClientIP: "192.0.2.1", ExpiresAt: now.Add(time.Second)}
	if e = s.Put("entry-admission-leases", "live", lease); e != nil {
		t.Fatal(e)
	}
	tx, e = s.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.admissionLiveWindowTx(tx, leaseLive, "u", now); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	v, e = s.UsageInsightsContext(context.Background(), "u", now.AddDate(0, 0, -2), now)
	if e != nil || !v.Admission.Available || v.Admission.ActiveStreams != 1 || len(v.Admission.OnlineIPs) != 1 || v.Admission.OnlineIPs[0] != "192.0.2.1" {
		t.Fatalf("hot projection %+v %v", v.Admission, e)
	}
	v, e = s.UsageInsightsContext(context.Background(), "u", now.AddDate(0, 0, -2), now.Add(2*time.Second))
	if e != nil || !v.Admission.Available || v.Admission.ActiveStreams != 0 {
		t.Fatalf("expired hot projection %+v %v", v.Admission, e)
	}
}

func TestInsightsOlderHistorySchemaRebuild(t *testing.T) {
	s, now := rebuildFixture(t)
	if e := s.Put("ledger", "a", rebuildRecord("u", 5, 1000000, now)); e != nil {
		t.Fatal(e)
	}
	var path string
	if e := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec(`DROP TABLE usage_history; CREATE TABLE usage_history(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id));`); e != nil {
		t.Fatal(e)
	}
	if e := s.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := Open(path, bytes.Repeat([]byte{17}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	v, e := reopened.UsageInsightsContext(context.Background(), "u", now.Add(-time.Hour), now)
	if e != nil || v.Daily[13].RawBytes != 5 {
		t.Fatalf("old schema recovery %+v %v", v, e)
	}
}
