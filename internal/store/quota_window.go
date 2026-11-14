package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"math/big"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"time"
)

type QuotaCoverageStatus struct {
	Available     bool
	Reason        string
	Start         time.Time
	End           time.Time
	RawBytes      uint64
	WeightedBytes uint64
	Generation    uint64
	Epoch         string
}

// Observations are prospective. At most nine overlapping windows start on
// daily zero-open boundaries; no active interval is divided or interpolated.
func (s *Store) ObserveQuotaCoverageContext(ctx context.Context, account string, now time.Time) (QuotaCoverageStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if !domain.ValidID(account) || now.IsZero() {
		return QuotaCoverageStatus{Reason: "invalid_account_or_time"}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return QuotaCoverageStatus{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE counters SET value=value WHERE kind='admission-lock'`); err != nil {
		return QuotaCoverageStatus{}, err
	}
	finish := func(v QuotaCoverageStatus) (QuotaCoverageStatus, error) { return v, tx.Commit() }
	var unsafe bool
	if err = s.getTx(tx, "quota-coverage-safety", "unknown", &unsafe); err != nil && err != ErrNotFound {
		return QuotaCoverageStatus{}, err
	}
	if unsafe {
		return finish(QuotaCoverageStatus{Reason: "coverage_capacity_unknown"})
	}
	proof, err := s.quotaSourcesTx(tx, account, now)
	if err != nil {
		return QuotaCoverageStatus{}, err
	}
	c, found, err := s.readQuotaCheckpointTx(tx, account)
	if err != nil {
		return QuotaCoverageStatus{}, err
	}
	if !proof.Available {
		if found && !c.Invalid {
			c.invalidateQuota()
			if err = s.putTx(tx, quotaCoverageKind, account, c); err != nil {
				return QuotaCoverageStatus{}, err
			}
		}
		return finish(QuotaCoverageStatus{Reason: proof.Reason})
	}
	if found && !c.Invalid && (!reflect.DeepEqual(c.Dependencies, proof.Dependencies) || !reflect.DeepEqual(c.RouteIDs, proof.RouteIDs) || now.Before(c.StartedAt) || now.Before(c.LastEventAt)) {
		c.invalidateQuota()
		if err = s.putTx(tx, quotaCoverageKind, account, c); err != nil {
			return QuotaCoverageStatus{}, err
		}
	}
	changed := false
	if !found || c.Invalid {
		if c.Generation == math.MaxUint64 {
			return finish(QuotaCoverageStatus{Reason: "coverage_generation_exhausted"})
		}
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM (SELECT 1 FROM records WHERE kind=? LIMIT ?)`, quotaCoverageKind, quotaCoverageLimit+1).Scan(&count); err != nil {
			return QuotaCoverageStatus{}, err
		}
		if !found && count >= quotaCoverageLimit {
			return finish(QuotaCoverageStatus{Reason: "coverage_capacity"})
		}
		ready, e := s.quotaStartBudgetsTx(ctx, tx, account)
		if e != nil {
			return QuotaCoverageStatus{}, e
		}
		if !ready {
			return finish(QuotaCoverageStatus{Reason: "budgets_not_closed_or_inventory_limit"})
		}
		epoch, e := quotaCoverageEpochTx(tx)
		if e != nil {
			return QuotaCoverageStatus{}, e
		}
		if len(epoch) != 64 {
			return finish(QuotaCoverageStatus{Reason: "invalid_coverage_epoch"})
		}
		c = quotaCoverageCheckpoint{Epoch: epoch, Version: quotaCheckpointVersion, AccountID: account, Generation: c.Generation + 1, StartedAt: now, LastEventAt: now, Dependencies: proof.Dependencies, RouteIDs: proof.RouteIDs}
		changed = true
	}
	if c.startQuotaWindow(now) {
		changed = true
	}
	if changed {
		encoded, e := json.Marshal(c)
		if e != nil || len(encoded) > 64000 {
			return finish(QuotaCoverageStatus{Reason: "coverage_record_limit"})
		}
		if err = s.putTx(tx, quotaCoverageKind, account, c); err != nil {
			return QuotaCoverageStatus{}, err
		}
	}
	return finish(quotaSealedWindow(c, now))
}
func quotaSealedWindow(c quotaCoverageCheckpoint, now time.Time) QuotaCoverageStatus {
	status := QuotaCoverageStatus{Reason: "collecting_complete_window", Start: c.StartedAt, End: c.StartedAt.Add(quotaCoverageDuration), Generation: c.Generation, Epoch: c.Epoch}
	if c.Invalid || c.Version != quotaCheckpointVersion || c.StartedAt.IsZero() || now.Before(c.LastEventAt) || now.Before(c.StartedAt) {
		status.Reason = "invalid_checkpoint"
		return status
	}
	// This is confirmed zero, not absence-of-ledger inference: this managed-only
	// checkpoint has tracked every issuance and final, no open budget remains,
	// and no budget event occurred anywhere in the complete seven-day interval.
	if c.Open == 0 && !c.LastEventAt.After(now.Add(-quotaCoverageDuration)) && !c.StartedAt.After(now.Add(-quotaCoverageDuration)) {
		status.Available = true
		status.Reason = ""
		status.Start = now.Add(-quotaCoverageDuration)
		status.End = now
		return status
	}
	var selected *quotaObservationWindow
	for i := range c.Windows {
		w := &c.Windows[i]
		if w.Invalid || w.End.Sub(w.Start) != quotaCoverageDuration || w.Start.Before(c.StartedAt) || w.End.After(now) || now.Sub(w.End) > 24*time.Hour || w.Closed != w.Issued {
			continue
		}
		if selected == nil || w.End.After(selected.End) {
			selected = w
		}
	}
	if selected == nil {
		return status
	}
	n, ok := new(big.Int).SetString(selected.WeightedNumerator, 10)
	if !ok || n.Sign() < 0 {
		status.Reason = "invalid_checkpoint"
		return status
	}
	n.Add(n, big.NewInt(service.RateScale-1))
	n.Div(n, big.NewInt(service.RateScale))
	if !n.IsUint64() {
		status.Reason = "usage_overflow"
		return status
	}
	status.Available = true
	status.Reason = ""
	status.Start = selected.Start
	status.End = selected.End
	status.RawBytes = selected.RawBytes
	status.WeightedBytes = n.Uint64()
	return status
}

// This one-time start gate rejects a bounded inventory it cannot fully inspect.
// Once active, issuance/final/byte evidence is maintained incrementally and
// sealing does not rescan an ever-growing historical budget list.
func (s *Store) quotaStartBudgetsTx(ctx context.Context, tx *sql.Tx, account string) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id,CASE WHEN length(data)<=65536 THEN data ELSE NULL END FROM records WHERE kind='admission-budgets' LIMIT 10001`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	count, total := 0, 0
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			return false, err
		}
		count++
		total += len(raw)
		if count > 10000 || total > 8<<20 || len(raw) == 0 {
			return false, nil
		}
		var b admissionBudget
		if err = s.open("admission-budgets", id, raw, &b); err != nil {
			return false, err
		}
		if b.AccountID == account && !b.Closed {
			return false, nil
		}
	}
	return true, rows.Err()
}
