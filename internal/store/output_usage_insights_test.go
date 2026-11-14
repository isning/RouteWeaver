package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"routeweaver/internal/service"
	"strings"
	"testing"
	"time"
)

func outputUsageRecord(owner, output, revision string, n int64, at time.Time) MeterRecord {
	return MeterRecord{OutputID: output, OutputRevision: revision, BudgetID: "budget", MeterBatch: MeterBatch{UserID: owner, RouteID: "route", MeterID: "admission-budget", RawBytes: n, ObservedAt: at}, RateMicros: service.RateScale}
}
func TestOutputUsageInsightsExactWindowRevisionIsolationAndUnattributed(t *testing.T) {
	s, _, _ := attributionFixture(t)
	now := time.Date(2026, 11, 14, 17, 0, 0, 500, time.UTC)
	start := time.Date(2026, 11, 2, 0, 0, 0, 0, service.DefaultLocation)
	records := map[string]MeterRecord{
		"a":        outputUsageRecord("owner", "deleted-output", "revision1", 1, now),
		"b":        outputUsageRecord("owner", "deleted-output", "revision2", 1, now),
		"boundary": outputUsageRecord("owner", "boundary-output", "revision", 4, start),
		"old":      outputUsageRecord("owner", "old-output", "revision", 100, start.Add(-time.Nanosecond)),
		"future":   outputUsageRecord("owner", "future-output", "revision", 100, now.Add(time.Nanosecond)),
		"foreign":  outputUsageRecord("foreign", "foreign-output", "revision", 900, now),
		"legacy":   outputUsageRecord("owner", "", "", 7, now),
	}
	a := records["a"]
	a.RateMicros = 500000
	records["a"] = a
	b := records["b"]
	b.RateMicros = 500000
	records["b"] = b
	for id, r := range records {
		if e := s.Put("ledger", id, r); e != nil {
			t.Fatal(e)
		}
	}
	v, e := s.OutputUsage14DayInsightsContext(context.Background(), "owner", now)
	if e != nil {
		t.Fatal(e)
	}
	if !v.Complete || !v.AsOf.Equal(now) || !v.WindowEnd.Equal(now) || !v.WindowStart.Equal(start) {
		t.Fatalf("window %+v", v)
	}
	if len(v.Outputs) != 2 || v.Outputs[0].OutputID != "boundary-output" || v.Outputs[0].RawBytes != 4 || v.Outputs[1].OutputID != "deleted-output" || v.Outputs[1].RawBytes != 2 || v.Outputs[1].WeightedBytes != 1 || v.UnattributedRawBytes != 7 || v.UnattributedWeightedBytes != 7 {
		t.Fatalf("buckets %+v", v)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if v, e = s.OutputUsage14DayInsightsContext(ctx, "owner", now); !errors.Is(e, context.Canceled) || v.Complete || len(v.Outputs) > 0 {
		t.Fatalf("cancel leaked partial %+v %v", v, e)
	}
}
func TestOutputUsageInsightsMalformedAttributionAndOverflowAreUnavailable(t *testing.T) {
	for _, scenario := range []string{"missing-revision", "missing-output", "invalid-id", "counter-source", "missing-budget", "raw-overflow", "weighted-overflow", "index-untrusted"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, now := attributionFixture(t)
			r := outputUsageRecord("owner", "one", "rev", 5, now)
			switch scenario {
			case "missing-revision":
				r.OutputRevision = ""
			case "missing-output":
				r.OutputID = ""
			case "invalid-id":
				r.OutputID = "../foreign"
			case "counter-source":
				r.MeterID = "generic"
			case "missing-budget":
				r.BudgetID = ""
			case "raw-overflow":
				r.RawBytes = math.MaxInt64
				r.RateMicros = 0
			case "weighted-overflow":
				r.RawBytes = math.MaxInt64
				r.RateMicros = 2 * service.RateScale
			}
			if e := s.Put("ledger", "first", r); e != nil {
				t.Fatal(e)
			}
			if scenario == "raw-overflow" {
				r.RawBytes = 1
				if e := s.Put("ledger", "second", r); e != nil {
					t.Fatal(e)
				}
			}
			if scenario == "index-untrusted" {
				if _, e := s.db.Exec("DROP INDEX usage_history_window"); e != nil {
					t.Fatal(e)
				}
			}
			v, e := s.OutputUsageInsightsContext(context.Background(), "owner", now)
			if !errors.Is(e, ErrInsightsUnavailable) || v.Complete || len(v.Outputs) > 0 || v.UnattributedRawBytes != 0 {
				t.Fatalf("not entirely unavailable %+v %v", v, e)
			}
		})
	}
}
func TestOutputUsageInsightsRejectsOverCapacityWithoutPartialTotals(t *testing.T) {
	s, _, now := attributionFixture(t)
	tx, e := s.beginWriteTx()
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i <= insightsRowLimit; i++ {
		if e = s.putTx(tx, "ledger", fmt.Sprintf("record-%05d", i), outputUsageRecord("owner", "one", "rev", 1, now.AddDate(0, 0, -40))); e != nil {
			tx.Rollback()
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	v, e := s.OutputUsageInsightsContext(context.Background(), "owner", now)
	if e == nil || v.Complete || len(v.Outputs) > 0 {
		t.Fatalf("truncated data reported complete %+v %v", v, e)
	}
	recent, e := s.OutputUsage14DayInsightsContext(context.Background(), "owner", now)
	if e != nil || !recent.Complete || len(recent.Outputs) != 0 {
		t.Fatalf("separate recent window %+v %v", recent, e)
	}
}

func TestOutputUsageInsightsRejectsRecordAndTotalByteCaps(t *testing.T) {
	for _, scenario := range []string{"record", "total"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, now := attributionFixture(t)
			count, size := 1, insightsRecordBytes+1
			if scenario == "total" {
				count, size = 150, 60000
			}
			tx, e := s.beginWriteTx()
			if e != nil {
				t.Fatal(e)
			}
			for i := 0; i < count; i++ {
				encoded, e := json.Marshal(outputUsageRecord("owner", "one", "rev", 1, now))
				if e != nil {
					t.Fatal(e)
				}
				var v map[string]any
				if e = json.Unmarshal(encoded, &v); e != nil {
					t.Fatal(e)
				}
				v["padding"] = strings.Repeat("x", size)
				if e = s.putTx(tx, "ledger", fmt.Sprintf("large-%03d", i), v); e != nil {
					tx.Rollback()
					t.Fatal(e)
				}
			}
			if e = tx.Commit(); e != nil {
				t.Fatal(e)
			}
			v, e := s.OutputUsageInsightsContext(context.Background(), "owner", now)
			if !errors.Is(e, ErrInsightsUnavailable) || v.Complete || len(v.Outputs) > 0 {
				t.Fatalf("byte cap not wholly unavailable %+v %v", v, e)
			}
		})
	}
}

func TestOutputUsageInsightsUsesAuthoritativeCycleAndManualReset(t *testing.T) {
	s, _, _ := attributionFixture(t)
	now := time.Date(2026, 11, 29, 8, 0, 0, 0, time.UTC)
	cycle := service.CyclePolicy{Mode: "monthly", Day: 1, Timezone: "UTC+8", Anchor: time.Date(2026, 10, 1, 0, 0, 0, 0, service.DefaultLocation)}
	if e := s.Put("entitlements", "owner", service.Entitlement{UserID: "owner", ServiceID: "plan", StartsAt: now.AddDate(0, 0, -50), Cycle: cycle}); e != nil {
		t.Fatal(e)
	}
	// This current-cycle event is older than 14 days and must not be dropped.
	old := now.AddDate(0, 0, -20)
	if e := s.Put("ledger", "old", outputUsageRecord("owner", "one", "rev", 19, old)); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("ledger", "new", outputUsageRecord("owner", "one", "rev2", 7, now)); e != nil {
		t.Fatal(e)
	}
	current, e := s.OutputUsageInsightsContext(context.Background(), "owner", now)
	if e != nil {
		t.Fatal(e)
	}
	expectedCycle, e := cycle.Window(now)
	if e != nil {
		t.Fatal(e)
	}
	if current.Period != "current-cycle" || !current.WindowStart.Equal(expectedCycle.Start) || len(current.Outputs) != 1 || current.Outputs[0].RawBytes != 26 {
		t.Fatalf("not current cycle %+v", current)
	}
	reset := now.Add(-time.Hour)
	if e := s.Put("resets", "manual", Reset{ID: "manual", UserID: "owner", At: reset}); e != nil {
		t.Fatal(e)
	}
	// Foreign and future reset records cannot change this owner's boundary.
	if e := s.Put("resets", "foreign", Reset{ID: "foreign", UserID: "other", At: now}); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("resets", "future", Reset{ID: "future", UserID: "owner", At: now.Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	current, e = s.OutputUsageInsightsContext(context.Background(), "owner", now)
	if e != nil {
		t.Fatal(e)
	}
	_, _, overviewCycle, e := s.UserInsightsContext(context.Background(), "owner", now)
	if e != nil {
		t.Fatal(e)
	}
	if !current.WindowStart.Equal(reset) || !current.WindowStart.Equal(overviewCycle.Start) || current.Outputs[0].RawBytes != 7 {
		t.Fatalf("reset mismatch %+v", current)
	}
}
