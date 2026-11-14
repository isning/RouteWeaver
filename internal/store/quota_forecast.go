package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"routeweaver/internal/service"
	"time"
)

// QuotaForecastContext starts prospective observation and only returns a forecast
// after revalidating the displayed overview against one reserved-writer snapshot.
// Failure is advisory and must never change billing or prevent viewing an account.
func (s *Store) QuotaForecastContext(ctx context.Context, account string, now time.Time, expected service.EffectivePolicy, cycle service.CycleWindow, usage service.UsageTotals, pending bool) (QuotaForecast, error) {
	unavailable := QuotaForecast{Reason: "coverage_unavailable", AsOf: now}
	// Unlimited/ineligible overviews have no depletion estimate to collect.
	if pending || expected.UserID != account || expected.Status != "active" || expected.QuotaBytes <= 0 {
		return unavailable, nil
	}
	coverage, err := s.ObserveQuotaCoverageContext(ctx, account, now)
	if err != nil {
		return unavailable, err
	}
	if !coverage.Available {
		unavailable.Reason = coverage.Reason
		return unavailable, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return unavailable, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE counters SET value=value WHERE kind='admission-lock'`); err != nil {
		return unavailable, err
	}
	var unsafe bool
	if err = s.getTx(tx, "quota-coverage-safety", "unknown", &unsafe); err != nil && err != ErrNotFound {
		return unavailable, err
	}
	if unsafe {
		return unavailable, nil
	}
	c, found, err := s.readQuotaCheckpointTx(tx, account)
	if err != nil {
		return unavailable, err
	}
	if !found || !reflect.DeepEqual(quotaSealedWindow(c, now), coverage) {
		return unavailable, nil
	}
	policy, currentCycle, err := s.insightsPolicyTx(ctx, tx, account, now)
	if err != nil {
		return unavailable, err
	}
	if !reflect.DeepEqual(policy, expected) || !reflect.DeepEqual(currentCycle, cycle) || cycle.Start.After(now) {
		unavailable.Reason = "overview_changed"
		return unavailable, nil
	}
	var sum insightSum
	err = s.visitInsightLedgerWindowTx(ctx, tx, account, cycle.Start, now, func(r MeterRecord) error {
		if !r.ObservedAt.Before(cycle.Start) {
			sum.add(r)
		}
		return nil
	})
	if err != nil {
		return unavailable, err
	}
	totals, err := sum.value()
	if err != nil {
		return unavailable, err
	}
	if totals.RawBytes != usage.RawBytes || totals.WeightedBytes != usage.WeightedBytes {
		unavailable.Reason = "overview_changed"
		return unavailable, nil
	}
	// Bound both the optional holds read and the live-reservation fallback before
	// invoking existing accounting code. Exceeding a cap is not partial evidence.
	for _, kind := range []string{"accounting-holds", "admission-budgets"} {
		if err = quotaForecastBoundTx(ctx, tx, kind); err != nil {
			return unavailable, err
		}
	}
	holds, err := s.listTx(tx, "accounting-holds")
	if err != nil {
		return unavailable, err
	}
	for _, raw := range holds {
		var hold AccountingHold
		if err = json.Unmarshal(raw, &hold); err != nil {
			return unavailable, err
		}
		if hold.UserID == account {
			return unavailable, nil
		}
	}
	reserved, reason, err := s.admissionLiveReservedTx(tx, account, policy.QuotaBytes, now)
	if err != nil {
		return unavailable, err
	}
	if reason != "" {
		unavailable.Reason = reason
		return unavailable, nil
	}
	remaining := policy.QuotaBytes - totals.WeightedBytes
	if remaining < 0 {
		remaining = 0
	}
	result := buildQuotaForecast(quotaForecastInput{WindowComplete: true, SealedUsageWeighted: coverage.WeightedBytes, WindowStart: coverage.Start, WindowEnd: coverage.End, Now: now, Remaining: remaining, Reserved: reserved, NextReset: cycle.NextReset, ServiceExpiry: policy.Entitlement.ExpiresAt})
	return result, tx.Commit()
}
func quotaForecastBoundTx(ctx context.Context, tx *sql.Tx, kind string) error {
	rows, err := tx.QueryContext(ctx, `SELECT length(data) FROM records WHERE kind=? LIMIT ?`, kind, insightsRowLimit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	count, total := 0, 0
	for rows.Next() {
		var n int
		if err = rows.Scan(&n); err != nil {
			return err
		}
		count++
		total += n
		if count > insightsRowLimit || n > insightsRecordBytes || total > 8*1024*1024 {
			return ErrInsightsUnavailable
		}
	}
	return rows.Err()
}
