package store

import (
	"encoding/json"
	"testing"
	"time"
)

func TestQuotaForecastUsesSettledBalanceMinusReservations(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	f := buildQuotaForecast(quotaForecastInput{WindowComplete: true, SealedUsageWeighted: 700, WindowStart: now.Add(-7 * 24 * time.Hour), WindowEnd: now, Now: now, Remaining: 1000, Reserved: 300})
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(now.Add(7*24*time.Hour)) {
		t.Fatalf("wrong conservative projection %+v", f)
	}
	if f.RemainingBytes != "1000" || f.ReservedBytes != "300" {
		t.Fatal("changed billing presentation", f)
	}
}

func validQuotaForecastInput() quotaForecastInput {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	return quotaForecastInput{WindowComplete: true, SealedUsageWeighted: 700, WindowStart: now.Add(-7 * 24 * time.Hour), WindowEnd: now, Now: now, Remaining: 1000, Reserved: 300}
}
func TestQuotaForecastRejectsIncompleteStaleInvalidOrUnfundedInput(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		change       func(*quotaForecastInput)
	}{
		{"incomplete", "incomplete_window", func(i *quotaForecastInput) { i.WindowComplete = false }},
		{"short", "invalid_window", func(i *quotaForecastInput) { i.WindowStart = i.WindowStart.Add(time.Second) }},
		{"long", "invalid_window", func(i *quotaForecastInput) { i.WindowStart = i.WindowStart.Add(-time.Second) }},
		{"future", "invalid_window", func(i *quotaForecastInput) { i.Now = i.Now.Add(-time.Second) }},
		{"stale", "stale_window", func(i *quotaForecastInput) { i.Now = i.Now.Add(24*time.Hour + time.Nanosecond) }},
		{"negative remaining", "invalid_quota", func(i *quotaForecastInput) { i.Remaining = -1 }},
		{"negative reserved", "invalid_quota", func(i *quotaForecastInput) { i.Reserved = -1 }},
		{"zero quota", "no_available_quota", func(i *quotaForecastInput) { i.Remaining = 0; i.Reserved = 0 }},
		{"reservation consumes balance", "no_available_quota", func(i *quotaForecastInput) { i.Reserved = i.Remaining }},
		{"over reserved", "no_available_quota", func(i *quotaForecastInput) { i.Reserved = i.Remaining + 1 }},
		{"expired reset", "expired_horizon", func(i *quotaForecastInput) { at := i.Now; i.NextReset = &at }},
		{"expired service", "expired_horizon", func(i *quotaForecastInput) { at := i.Now.Add(-time.Second); i.ServiceExpiry = &at }},
		{"tiny rate distant date", "estimate_out_of_range", func(i *quotaForecastInput) { i.SealedUsageWeighted = 1 }},
		{"sub nanosecond date", "estimate_out_of_range", func(i *quotaForecastInput) { i.Remaining = 1; i.Reserved = 0; i.SealedUsageWeighted = ^uint64(0) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := validQuotaForecastInput()
			tc.change(&in)
			f := buildQuotaForecast(in)
			if f.Available || f.Reason != tc.reason || f.EstimatedExhaustionAt != nil || f.EnoughUntilHorizon != nil {
				t.Fatalf("unsafe estimate %+v", f)
			}
		})
	}
	in := validQuotaForecastInput()
	in.Now = in.Now.Add(24 * time.Hour)
	f := buildQuotaForecast(in)
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(in.Now.Add(7*24*time.Hour)) {
		t.Fatal("freshness edge or estimate not anchored to now", f)
	}
}
func TestQuotaForecastUsesEarliestHorizonAndDoesNotPredictInfinity(t *testing.T) {
	in := validQuotaForecastInput()
	reset, expiry := in.Now.Add(6*24*time.Hour), in.Now.Add(8*24*time.Hour)
	in.NextReset = &reset
	in.ServiceExpiry = &expiry
	f := buildQuotaForecast(in)
	if !f.Available || f.Horizon == nil || !f.Horizon.Equal(reset) || f.EnoughUntilHorizon == nil || !*f.EnoughUntilHorizon || f.EstimatedExhaustionAt != nil {
		t.Fatal(f)
	}
	reset = in.Now.Add(9 * 24 * time.Hour)
	f = buildQuotaForecast(in)
	if !f.Available || f.Horizon == nil || !f.Horizon.Equal(expiry) || f.EnoughUntilHorizon == nil || *f.EnoughUntilHorizon || f.EstimatedExhaustionAt == nil {
		t.Fatal(f)
	}
	in.SealedUsageWeighted = 0
	f = buildQuotaForecast(in)
	if !f.Available || f.EnoughUntilHorizon == nil || !*f.EnoughUntilHorizon || f.EstimatedExhaustionAt != nil {
		t.Fatal("zero usage with finite horizon", f)
	}
	in.NextReset = nil
	in.ServiceExpiry = nil
	f = buildQuotaForecast(in)
	if f.Available || f.Reason != "no_observed_usage" || f.EstimatedExhaustionAt != nil {
		t.Fatal("invented unlimited future", f)
	}
}
func TestQuotaForecastRetainsExactLargeWeightedByteArithmetic(t *testing.T) {
	in := validQuotaForecastInput()
	in.Remaining = 9007199254740993
	in.Reserved = 1
	in.SealedUsageWeighted = 9007199254740992
	f := buildQuotaForecast(in)
	if !f.Available || f.RemainingBytes != "9007199254740993" || !f.EstimatedExhaustionAt.Equal(in.Now.Add(7*24*time.Hour)) {
		t.Fatal("lost safe integer precision", f)
	}
	in.Remaining = 9223372036854775807
	in.Reserved = 0
	in.SealedUsageWeighted = 18446744073709551615
	f = buildQuotaForecast(in)
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(in.Now.Add(302399999999999*time.Nanosecond)) {
		t.Fatal("intermediate overflow or rounded exhaustion later", f)
	}
}

func TestQuotaForecastInvalidTimestampStillSerializesUnavailable(t *testing.T) {
	in := validQuotaForecastInput()
	in.Now = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	f := buildQuotaForecast(in)
	if f.Available || f.Reason != "invalid_window" {
		t.Fatal(f)
	}
	if _, err := json.Marshal(f); err != nil {
		t.Fatal("invalid input escaped unavailable response", err)
	}
}

func TestQuotaForecastExactLimits(t *testing.T) {
	in := validQuotaForecastInput()
	in.Remaining = 36600
	in.Reserved = 0
	f := buildQuotaForecast(in)
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(in.Now.Add(366*24*time.Hour)) {
		t.Fatal("366 day boundary", f)
	}
	in.Remaining = 36700
	f = buildQuotaForecast(in)
	if f.Available || f.EstimatedExhaustionAt != nil {
		t.Fatal("unbounded horizon", f)
	}
	in = validQuotaForecastInput()
	at := in.Now.Add(7 * 24 * time.Hour)
	in.NextReset = &at
	f = buildQuotaForecast(in)
	if !f.Available || f.EnoughUntilHorizon == nil || !*f.EnoughUntilHorizon || f.EstimatedExhaustionAt != nil {
		t.Fatal("exact reset boundary", f)
	}
}

func TestQuotaForecastDistantHorizonNeverExtendsProjectionLimit(t *testing.T) {
	in := validQuotaForecastInput()
	far := in.Now.Add(2 * 366 * 24 * time.Hour)
	in.NextReset = &far
	in.SealedUsageWeighted = 0
	f := buildQuotaForecast(in)
	if f.Available || f.EnoughUntilHorizon != nil || f.EstimatedExhaustionAt != nil || f.Horizon == nil || !f.Horizon.Equal(far) {
		t.Fatal("zero use projected across years or changed horizon", f)
	}
	in.SealedUsageWeighted = 700
	in.Remaining = 100000
	in.Reserved = 0
	f = buildQuotaForecast(in)
	if f.Available || f.EnoughUntilHorizon != nil || f.EstimatedExhaustionAt != nil {
		t.Fatal("slow use projected beyond limit", f)
	}
	in.Remaining = 700
	f = buildQuotaForecast(in)
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(in.Now.Add(7*24*time.Hour)) || f.EnoughUntilHorizon == nil || *f.EnoughUntilHorizon || !f.Horizon.Equal(far) {
		t.Fatal("distant horizon hid safe near-term date", f)
	}
	far = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	f = buildQuotaForecast(in)
	if !f.Available || f.EstimatedExhaustionAt == nil || !f.EstimatedExhaustionAt.Equal(in.Now.Add(7*24*time.Hour)) {
		t.Fatal("distant date overflowed duration comparison", f)
	}
	in.SealedUsageWeighted = 0
	far = in.Now.Add(366 * 24 * time.Hour)
	f = buildQuotaForecast(in)
	if !f.Available || f.EnoughUntilHorizon == nil || !*f.EnoughUntilHorizon {
		t.Fatal("exact maximum horizon refused", f)
	}
	far = far.Add(time.Nanosecond)
	f = buildQuotaForecast(in)
	if f.Available || f.EnoughUntilHorizon != nil {
		t.Fatal("horizon limit rounded outward", f)
	}
}
