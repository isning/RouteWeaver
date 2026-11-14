package store

import (
	"context"
	"database/sql"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"sort"
	"time"
)

type OutputUsageBucket struct {
	OutputID string `json:"outputId"`
	InsightUsage
}
type OutputUsageInsights struct {
	Period                    string              `json:"period"`
	AsOf                      time.Time           `json:"asOf"`
	WindowStart               time.Time           `json:"windowStart"`
	WindowEnd                 time.Time           `json:"windowEnd"`
	Outputs                   []OutputUsageBucket `json:"outputs"`
	UnattributedRawBytes      int64               `json:"unattributedRawBytes"`
	UnattributedWeightedBytes int64               `json:"unattributedWeightedBytes"`
	Complete                  bool                `json:"complete"`
}

// OutputUsageInsightsContext reports the authoritative current service cycle,
// including manual reset boundaries, from the same snapshot as the ledger.
// No caller-selected time range is accepted. Unlimited cycles may exceed the
// bounded scan and then return unavailable, never a fabricated recent subtotal.
func (s *Store) OutputUsageInsightsContext(ctx context.Context, owner string, now time.Time) (OutputUsageInsights, error) {
	return s.outputUsageInsightsContext(ctx, owner, now, "current-cycle")
}

// OutputUsage14DayInsightsContext is an explicitly separate fixed UTC+8 window,
// not a substitute for current-cycle usage.
func (s *Store) OutputUsage14DayInsightsContext(ctx context.Context, owner string, now time.Time) (OutputUsageInsights, error) {
	return s.outputUsageInsightsContext(ctx, owner, now, "14-days")
}

// Every output revision sums into its output bucket. Weighted bytes round once
// per bucket; summed buckets can differ by rounding bytes from one whole-period
// aggregate. Incomplete or invalid input returns no partial totals.
func (s *Store) outputUsageInsightsContext(ctx context.Context, owner string, now time.Time, period string) (OutputUsageInsights, error) {
	if !domain.ValidID(owner) || now.IsZero() {
		return OutputUsageInsights{}, ErrInsightsUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	local := now.In(service.DefaultLocation)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, service.DefaultLocation).AddDate(0, 0, -13)
	groups := map[string]*insightSum{}
	err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if period == "current-cycle" {
			_, cycle, err := s.insightsPolicyTx(ctx, tx, owner, now)
			if err != nil {
				return err
			}
			start = cycle.Start
		}
		return s.visitInsightLedgerWindowTx(ctx, tx, owner, start, now, func(r MeterRecord) error {
			if (r.OutputID != "" || r.OutputRevision != "") &&
				(!domain.ValidID(r.OutputID) || !domain.ValidID(r.OutputRevision) || r.MeterID != "admission-budget" || r.BudgetID == "") {
				return ErrInsightsUnavailable
			}
			// The SQL index uses whole seconds; preserve exact boundary semantics.
			if r.ObservedAt.Before(start) {
				return nil
			}
			if groups[r.OutputID] == nil {
				groups[r.OutputID] = &insightSum{}
			}
			groups[r.OutputID].add(r)
			return nil
		})
	})
	if err != nil {
		return OutputUsageInsights{}, err
	}
	out := OutputUsageInsights{Period: period, AsOf: now, WindowStart: start, WindowEnd: now, Outputs: []OutputUsageBucket{}}
	ids := []string{}
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		sum, err := groups[id].value()
		if err != nil {
			return OutputUsageInsights{}, err
		}
		if id == "" {
			out.UnattributedRawBytes = sum.RawBytes
			out.UnattributedWeightedBytes = sum.WeightedBytes
		} else {
			out.Outputs = append(out.Outputs, OutputUsageBucket{OutputID: id, InsightUsage: sum})
		}
	}
	out.Complete = true
	return out, nil
}
