package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"strings"
	"testing"
	"time"
)

func platformSnapshotFixture(t *testing.T) (*Store, time.Time) {
	s, _, now := attributionFixture(t)
	for _, w := range []RecordWrite{{"accounts", "owner", Account{ID: "owner"}}, {"published-routes", "route", domain.PublishedRoute{ID: "route"}}, {TenantKind("owner", "platform-entries"), "entry", map[string]any{"id": "entry", "userId": "owner", "revoked": false}}} {
		if e := s.Put(w.Kind, w.ID, w.Value); e != nil {
			t.Fatal(e)
		}
	}
	return s, now
}
func capturePlatform(t *testing.T, s *Store, now time.Time) *PlatformComparisonSnapshot {
	t.Helper()
	b := 2 << 20
	p, e := s.PlatformComparisonSnapshot(context.Background(), "owner", now, &b)
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func TestPlatformComparisonSnapshotImmutableAndFenced(t *testing.T) {
	s, now := platformSnapshotFixture(t)
	b := 2 << 20
	p, e := s.PlatformComparisonSnapshot(context.Background(), "owner", now, &b)
	if e != nil {
		t.Fatal(e)
	}
	policy, err := s.EffectivePolicy("owner", now)
	if err != nil || !reflect.DeepEqual(policy, p.policy) {
		t.Fatal("captured policy differs from canonical", err)
	}
	if b >= 2<<20 {
		t.Fatal("budget not charged")
	}
	if e = p.Eligible("route"); e != nil {
		t.Fatal(e)
	}
	if e = p.Eligible("other"); e == nil {
		t.Fatal("unauthorized route")
	}
	var v map[string]any
	if e = p.TenantGet("other", "platform-entries", "entry", &v); e == nil {
		t.Fatal("other tenant")
	}
	if e = p.Get("secrets", "id", &v); e == nil {
		t.Fatal("unlisted kind")
	}
	raw, _ := p.List(TenantKind("owner", "platform-entries"))
	raw[0][0] = '!'
	if e = p.TenantGet("owner", "platform-entries", "entry", &v); e != nil {
		t.Fatal("mutable bytes", e)
	}
	if e = s.TenantPut("owner", "platform-entries", "entry", map[string]any{"revoked": true}); e != nil {
		t.Fatal(e)
	}
	q := capturePlatform(t, s, now)
	if p.Fingerprint() == q.Fingerprint() {
		t.Fatal("revocation not fenced")
	}
	if e = p.TenantGet("owner", "platform-entries", "entry", &v); e != nil || v["revoked"] != false {
		t.Fatal("snapshot changed")
	}
	if e = s.Put("agent-observations", "new", map[string]string{"id": "new"}); e != nil {
		t.Fatal(e)
	}
	if capturePlatform(t, s, now).Fingerprint() == q.Fingerprint() {
		t.Fatal("new membership not fenced")
	}
}
func TestPlatformComparisonSnapshotBoundsAndCancellation(t *testing.T) {
	for _, mode := range []string{"rows", "bytes", "shared", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			s, now := platformSnapshotFixture(t)
			b := 2 << 20
			ctx := context.Background()
			switch mode {
			case "rows":
				for i := 0; i < 65; i++ {
					if e := s.Put("agent-observations", fmt.Sprint(i), json.RawMessage(`{}`)); e != nil {
						t.Fatal(e)
					}
				}
			case "bytes":
				if e := s.Put("agent-observations", "big", strings.Repeat("x", 65536)); e != nil {
					t.Fatal(e)
				}
			case "shared":
				b = 20
			case "cancel":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			}
			if _, e := s.PlatformComparisonSnapshot(ctx, "owner", now, &b); !errors.Is(e, ErrPlatformComparisonUnavailable) {
				t.Fatal(e)
			}
		})
	}
}
func TestPlatformComparisonSnapshotHoldDeadlineAndNoWrites(t *testing.T) {
	s, now := platformSnapshotFixture(t)
	expires := now.Add(5 * time.Second)
	if e := s.Put("admission-budgets", "b", admissionBudget{AccountID: "owner", Finite: true, GrantedRaw: 10, ExpiresAt: expires}); e != nil {
		t.Fatal(e)
	}
	p := capturePlatform(t, s, now)
	if !p.ValidUntil().Equal(expires) {
		t.Fatal(p.ValidUntil())
	}
	if e := p.Eligible("route"); e != nil {
		t.Fatal(e)
	}
	q := capturePlatform(t, s, expires)
	if e := q.Eligible("route"); e == nil {
		t.Fatal("expired unresolved budget eligible")
	}
	if p.Fingerprint() != q.Fingerprint() {
		t.Fatal("clock must not fake mutation")
	}
	// Snapshot reads must never build or repair a quota projection.
	var n int
	if e := s.db.QueryRow(`SELECT count(*) FROM usage_windows`).Scan(&n); e != nil || n != 0 {
		t.Fatal(n, e)
	}
	if e := s.Put("resets", "future", Reset{UserID: "owner", At: now.Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	b := 2 << 20
	if _, e := s.PlatformComparisonSnapshot(context.Background(), "owner", now, &b); e == nil {
		t.Fatal("future reset accepted")
	}
}

func TestPlatformComparisonSnapshotCanonicalUsageAndHold(t *testing.T) {
	for _, mode := range []string{"quota", "hold", "future-ledger", "identity"} {
		t.Run(mode, func(t *testing.T) {
			s, now := platformSnapshotFixture(t)
			switch mode {
			case "quota":
				var plan service.Plan
				if e := s.Get("services", "plan", &plan); e != nil {
					t.Fatal(e)
				}
				plan.QuotaBytes = 1
				if e := s.Put("services", "plan", plan); e != nil {
					t.Fatal(e)
				}
				if e := s.Put("ledger", "m", MeterRecord{MeterBatch: MeterBatch{UserID: "owner", RawBytes: 2, ObservedAt: now}, RateMicros: 1000000}); e != nil {
					t.Fatal(e)
				}
			case "hold":
				if e := s.Put("accounting-holds", "h", AccountingHold{UserID: "owner"}); e != nil {
					t.Fatal(e)
				}
			case "identity":
				if e := s.Put("published-routes", "route", domain.PublishedRoute{ID: "other"}); e != nil {
					t.Fatal(e)
				}
			case "future-ledger":
				if e := s.Put("ledger", "m", MeterRecord{MeterBatch: MeterBatch{UserID: "owner", RawBytes: 2, ObservedAt: now.Add(time.Hour)}, RateMicros: 1000000}); e != nil {
					t.Fatal(e)
				}
			}
			b := 2 << 20
			p, e := s.PlatformComparisonSnapshot(context.Background(), "owner", now, &b)
			if mode == "future-ledger" {
				if e == nil {
					t.Fatal("future ledger accepted")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if p.Eligible("route") == nil {
				t.Fatal("ineligible result")
			}
		})
	}
}
