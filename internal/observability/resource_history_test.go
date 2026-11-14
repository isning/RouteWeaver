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
