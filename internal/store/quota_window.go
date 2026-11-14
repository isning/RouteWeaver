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
}

// ObserveQuotaCoverageContext begins or seals a bounded future observation.
// It is not a prediction and is not exposed by the user API. Callers must not
// describe unavailable, old or partial periods as seven days of zero use.
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
			c.Invalid = true
			c.StartedAt = time.Time{}
			if c.Generation < math.MaxUint64 {
				c.Generation++
			}
			if err = s.putTx(tx, quotaCoverageKind, account, c); err != nil {
				return QuotaCoverageStatus{}, err
			}
		}
		return finish(QuotaCoverageStatus{Reason: proof.Reason})
	}
	if found && (c.Version != 1 || c.AccountID != account) {
		return finish(QuotaCoverageStatus{Reason: "invalid_checkpoint"})
	}
	if found && !c.Invalid && (!reflect.DeepEqual(c.Dependencies, proof.Dependencies) || !reflect.DeepEqual(c.RouteIDs, proof.RouteIDs) || now.Before(c.StartedAt)) {
		c.Invalid = true
	}
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
		ready, err := s.quotaStartBudgetsTx(ctx, tx, account)
		if err != nil {
			return QuotaCoverageStatus{}, err
		}
		if !ready {
			return finish(QuotaCoverageStatus{Reason: "budgets_not_closed_or_inventory_limit"})
		}
		epoch, e := quotaCoverageEpochTx(tx)
		if e != nil {
			return QuotaCoverageStatus{}, e
		}
		c = quotaCoverageCheckpoint{Epoch: epoch, Version: 1, AccountID: account, Generation: c.Generation + 1, StartedAt: now, Dependencies: proof.Dependencies, RouteIDs: proof.RouteIDs, WeightedNumerator: "0"}
		encoded, encodeErr := json.Marshal(c)
		if encodeErr != nil || len(encoded) > 64000 {
			return finish(QuotaCoverageStatus{Reason: "coverage_record_limit"})
		}
		if err = s.putTx(tx, quotaCoverageKind, account, c); err != nil {
			return QuotaCoverageStatus{}, err
		}
	}
	status := QuotaCoverageStatus{Start: c.StartedAt, End: c.StartedAt.Add(quotaCoverageDuration), Reason: "collecting_complete_window"}
	if now.Before(status.End) {
		return finish(status)
	}
	if c.Issued != c.Closed {
		status.Reason = "window_has_unclosed_budgets"
		return finish(status)
	}
	total, ok := new(big.Int).SetString(c.WeightedNumerator, 10)
	if !ok || total.Sign() < 0 || c.Closed > c.Issued {
		return finish(QuotaCoverageStatus{Reason: "invalid_checkpoint"})
	}
	total.Add(total, big.NewInt(service.RateScale-1))
	total.Div(total, big.NewInt(service.RateScale))
	if !total.IsUint64() {
		return finish(QuotaCoverageStatus{Reason: "usage_overflow"})
	}
	status.Available = true
	status.Reason = ""
	status.RawBytes = c.RawBytes
	status.WeightedBytes = total.Uint64()
	return finish(status)
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
