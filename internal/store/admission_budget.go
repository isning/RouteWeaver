package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"routeweaver/internal/service"
	"time"
)

const AdmissionBudgetChunk uint64 = 1 << 20

// admissionBudget is a reservation, not consumption. Only monotonically
// reported admitted bytes enter the ledger. Expiry never refunds its remainder.
type admissionBudget struct {
	LeaseID        string       `json:"leaseId"`
	AccountID      string       `json:"accountId"`
	RouteID        string       `json:"routeId"`
	GrantedRaw     uint64       `json:"grantedRaw,string"`
	SettledRaw     uint64       `json:"settledRaw,string"`
	Finite         bool         `json:"finite"`
	Closed         bool         `json:"closed"`
	CycleStart     time.Time    `json:"cycleStart"`
	PolicyEnd      *time.Time   `json:"policyEnd,omitempty"`
	Rate           service.Rate `json:"rate"`
	IssuedAt       time.Time    `json:"issuedAt"`
	ExpiresAt      time.Time    `json:"expiresAt"`
	LastSettlement time.Time    `json:"lastSettlement"`
	Sequence       uint64       `json:"sequence,string"`
}
type budgetPolicy struct {
	Quota      int64
	CycleStart time.Time
	CycleEnd   *time.Time
	End        *time.Time
	Rate       service.Rate
}

func earlier(a *time.Time, b time.Time) *time.Time {
	if a == nil || b.Before(*a) {
		v := b
		return &v
	}
	return a
}
func (s *Store) admissionBudgetPolicy(tx *sql.Tx, binding EntryAdmissionBinding, now time.Time) (budgetPolicy, error) {
	var result budgetPolicy
	effective, e := s.effectivePolicyTx(tx, binding.UserID, now)
	if e != nil {
		return result, e
	}
	result.Quota = effective.QuotaBytes
	ent := effective.Entitlement
	window, e := ent.Cycle.Window(now)
	if e != nil {
		return result, e
	}
	result.CycleStart = window.Start
	result.CycleEnd = window.NextReset
	result.End = window.NextReset
	if ent.ExpiresAt != nil {
		result.End = earlier(result.End, *ent.ExpiresAt)
	}
	resets, e := s.listTx(tx, "resets")
	if e != nil {
		return result, e
	}
	for _, raw := range resets {
		var reset Reset
		if e = json.Unmarshal(raw, &reset); e != nil {
			return result, e
		}
		if reset.UserID == binding.UserID && reset.At.After(result.CycleStart) && !reset.At.After(now) {
			result.CycleStart = reset.At
		}
	}
	result.Rate = service.Rate{ID: "default-1x", RouteID: binding.RouteID, Micros: service.RateScale}
	rates, e := s.listTx(tx, "rates")
	if e != nil {
		return result, e
	}
	for _, raw := range rates {
		var rate service.Rate
		if e = json.Unmarshal(raw, &rate); e != nil {
			return result, e
		}
		if rate.RouteID != binding.RouteID {
			continue
		}
		if rate.EffectiveAt.After(now) {
			result.End = earlier(result.End, rate.EffectiveAt)
		} else if rate.EffectiveAt.After(result.Rate.EffectiveAt) {
			result.Rate = rate
		}
	}
	return result, nil
}
func (s *Store) settleAdmissionBudget(tx *sql.Tx, budget *admissionBudget, in AdmissionRequest, now time.Time) error {
	if in.AdmittedBytes < budget.SettledRaw {
		return ErrConflict
	}
	if in.AdmittedBytes > math.MaxInt64 || budget.Finite && in.AdmittedBytes > budget.GrantedRaw {
		return ErrAdmissionEvidence
	}
	if budget.Closed && in.AdmittedBytes != budget.SettledRaw {
		return ErrAdmissionEvidence
	}
	delta := in.AdmittedBytes - budget.SettledRaw
	if delta > 0 {
		at := now
		if !at.Before(budget.ExpiresAt) {
			at = budget.ExpiresAt.Add(-time.Nanosecond)
		}
		weighted, e := service.WeightedBytes(int64(delta), budget.Rate.Micros)
		if e != nil {
			return e
		}
		budget.Sequence++
		record := MeterRecord{MeterBatch: MeterBatch{UserID: budget.AccountID, RouteID: budget.RouteID, MeterID: "admission-budget", Epoch: budget.LeaseID, Sequence: budget.Sequence, RawBytes: int64(delta), ObservedAt: at}, RateID: budget.Rate.ID, RateMicros: budget.Rate.Micros, WeightedBytes: weighted, RecordedAt: now, IntervalStart: budget.LastSettlement, IntervalEnd: at, BudgetID: budget.LeaseID}
		if e = s.putTx(tx, "ledger", fmt.Sprintf("admission:%s:%d", budget.LeaseID, in.AdmittedBytes), record); e != nil {
			return e
		}
		budget.SettledRaw = in.AdmittedBytes
		budget.LastSettlement = at
	}
	if in.Final {
		budget.Closed = true
	}
	return s.putTx(tx, "admission-budgets", budget.LeaseID, budget)
}
func (s *Store) grantAdmissionBudget(tx *sql.Tx, binding EntryAdmissionBinding, leaseID string, budget *admissionBudget, now, until time.Time) (*uint64, string, error) {
	policy, e := s.admissionBudgetPolicy(tx, binding, now)
	if e != nil {
		return nil, "", e
	}
	if budget.LeaseID != "" {
		if budget.Closed {
			return nil, "presence-closed", nil
		}
		if !now.Before(budget.ExpiresAt) {
			return nil, "quota-budget-pending", nil
		}
		if !budget.CycleStart.Equal(policy.CycleStart) || budget.Rate.ID != policy.Rate.ID || budget.Rate.Micros != policy.Rate.Micros || (budget.Finite != (policy.Quota > 0)) {
			return nil, "policy-boundary-reconnect", nil
		}
	} else {
		*budget = admissionBudget{LeaseID: leaseID, AccountID: binding.UserID, RouteID: binding.RouteID, Finite: policy.Quota > 0, CycleStart: policy.CycleStart, PolicyEnd: policy.End, Rate: policy.Rate, IssuedAt: now, LastSettlement: now}
	}
	if policy.End != nil && policy.End.Before(until) {
		until = *policy.End
	}
	if budget.PolicyEnd != nil && budget.PolicyEnd.Before(until) {
		until = *budget.PolicyEnd
	}
	if !until.After(now) {
		return nil, "policy-boundary-reconnect", nil
	}
	reserved, reason, e := s.admissionLiveReservedTx(tx, binding.UserID, policy.Quota, now)
	if e != nil || reason != "" {
		return nil, reason, e
	}
	budget.ExpiresAt = until
	if !budget.Finite {
		if e = s.putTx(tx, "admission-budgets", leaseID, budget); e != nil {
			return nil, "", e
		}
		return nil, "", nil
	}
	// Request arrival can precede another already-committed settlement while
	// waiting for SQLite. Read all committed facts in this immutable calendar
	// window, not an arrival-time snapshot that would refund settled bytes.
	end := time.Time{}
	if policy.CycleEnd != nil {
		end = *policy.CycleEnd
	}
	usage, e := s.currentUsageTx(tx, binding.UserID, policy.CycleStart, end)
	if e != nil {
		return nil, "", e
	}
	available := policy.Quota - usage.WeightedBytes
	if reserved > available {
		available = 0
	} else {
		available -= reserved
	}
	remaining := budget.GrantedRaw - budget.SettledRaw
	add := uint64(0)
	if remaining < AdmissionBudgetChunk {
		add = AdmissionBudgetChunk - remaining
	}
	if budget.Rate.Micros > 0 {
		possible := new(big.Int).Mul(big.NewInt(available), big.NewInt(service.RateScale))
		possible.Div(possible, big.NewInt(budget.Rate.Micros))
		if possible.Sign() <= 0 {
			add = 0
		} else if possible.IsUint64() && possible.Uint64() < add {
			add = possible.Uint64()
		}
	}
	if add > math.MaxInt64-budget.GrantedRaw {
		return nil, "", fmt.Errorf("budget counter exhausted")
	}
	budget.GrantedRaw += add
	if budget.GrantedRaw == budget.SettledRaw {
		return nil, "quota-reserved", nil
	}
	if e = s.putTx(tx, "admission-budgets", leaseID, budget); e != nil {
		return nil, "", e
	}
	ceiling := budget.GrantedRaw
	return &ceiling, "", nil
}
func (s *Store) unresolvedBudgetHold(user string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return false, e
	}
	defer tx.Rollback()
	return s.unresolvedBudgetHoldTx(tx, user, now)
}
func (s *Store) unresolvedBudgetHoldTx(tx *sql.Tx, user string, now time.Time) (bool, error) {
	raw, e := s.listTx(tx, "admission-budgets")
	if e != nil {
		return false, e
	}
	for _, b := range raw {
		var budget admissionBudget
		if e = json.Unmarshal(b, &budget); e != nil {
			return false, e
		}
		if budget.AccountID == user && !budget.Closed && !now.Before(budget.ExpiresAt) && (!budget.Finite || budget.GrantedRaw > budget.SettledRaw) {
			return true, nil
		}
	}
	return false, nil
}

// canonicalAdmissionReservedTx retains the original ordered evaluator for
// exceptional canonical data. Authentication/raw validation precedes typed decode.
func (s *Store) canonicalAdmissionReservedTx(tx *sql.Tx, account string, quota int64, now time.Time) (int64, string, error) {
	all, e := s.listTx(tx, "admission-budgets")
	if e != nil {
		return 0, "", e
	}
	reserved := int64(0)
	for _, raw := range all {
		var other admissionBudget
		if e = json.Unmarshal(raw, &other); e != nil {
			return 0, "", e
		}
		if other.AccountID != account || other.Closed {
			continue
		}
		outstanding := other.GrantedRaw - other.SettledRaw
		if !other.Finite {
			if quota > 0 || !now.Before(other.ExpiresAt) {
				return 0, "quota-budget-pending", nil
			}
			continue
		}
		if outstanding == 0 {
			continue
		}
		if !now.Before(other.ExpiresAt) {
			return 0, "quota-budget-pending", nil
		}
		cost, e := service.WeightedBytes(int64(outstanding), other.Rate.Micros)
		if e != nil {
			return 0, "", e
		}
		if cost > math.MaxInt64-reserved {
			return 0, "", fmt.Errorf("reservation aggregate overflow")
		}
		reserved += cost
	}
	return reserved, "", nil
}
