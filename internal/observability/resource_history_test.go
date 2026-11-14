package observability_test

import (
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestResourceHistoryKeepsBoundedRealSamplesAndBreaks(t *testing.T) {
	s, r, now := fixture(t)
	h := observability.ResourceHistory{}
	h, changed := observability.AppendResourceHistory(h, *s.Latest, now)
	if !changed || len(h.Points) != 1 || h.Points[0].CPUPercent != nil {
		t.Fatal("initial history invented CPU", h)
	}
	r = advance(r)
	s, _, _ = observability.Accept(s, r, r.ObservedAt)
	h, changed = observability.AppendResourceHistory(h, *s.Latest, r.ObservedAt)
	if changed || len(h.Points) != 1 {
		t.Fatal("wrote more than once in bucket")
	}
	for i := 0; i < 1500; i++ {
		r = advance(r)
		s, _, _ = observability.Accept(s, r, r.ObservedAt)
		h, _ = observability.AppendResourceHistory(h, *s.Latest, r.ObservedAt)
	}
	if len(h.Points) > 288 || !h.Points[0].ObservedAt.After(r.ObservedAt.Add(-24*time.Hour)) {
		t.Fatal("unbounded retention", len(h.Points))
	}
	r = advance(r)
	r.Metrics.CounterEpoch = "reboot"
	r.Digest = observability.ReportDigest(r)
	s, _, _ = observability.Accept(s, r, r.ObservedAt)
	h, changed = observability.AppendResourceHistory(h, *s.Latest, r.ObservedAt)
	if !changed || !h.Points[len(h.Points)-1].BreakBefore || h.Points[len(h.Points)-1].CPUPercent != nil {
		t.Fatal("restart was connected", h)
	}
	h = observability.PruneResourceHistory(h, r.ObservedAt.Add(25*time.Hour))
	if len(h.Points) != 0 {
		t.Fatal("stale samples returned")
	}
}

func TestResourceHistoryHourlyTierIsBoundedAndNeverBackfilled(t *testing.T) {
	s, _, now := fixture(t)
	h := observability.ResourceHistory{Points: []observability.ResourcePoint{{ObservedAt: now.Add(-time.Hour), MemoryUsedPercent: 10}}}
	h, _ = observability.AppendResourceHistory(h, *s.Latest, now)
	if len(h.Hourly) != 1 || !h.Hourly[0].ObservedAt.Equal(s.Latest.ObservedAt) {
		t.Fatal("backfilled hourly history")
	}
	for i := 1; i <= 200; i++ {
		snapshot := *s.Latest
		snapshot.ObservedAt = now.Add(time.Duration(i) * time.Hour)
		snapshot.Continuity = "continuous"
		h, _ = observability.AppendResourceHistory(h, snapshot, snapshot.ObservedAt)
	}
	if len(h.Hourly) != 168 || len(h.Points) > 288 {
		t.Fatal("unbounded tiers", len(h.Hourly), len(h.Points))
	}
	if h.Hourly[len(h.Hourly)-1].BreakBefore {
		t.Fatal("normal hourly sampling treated as gap")
	}
	h = observability.PruneResourceHistory(h, now.Add(369*time.Hour))
	if len(h.Hourly) != 0 || len(h.Points) != 0 {
		t.Fatal("expired history retained")
	}
}
