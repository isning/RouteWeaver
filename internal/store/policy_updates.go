package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"routeweaver/internal/service"
	"time"
)

// These commands fence policy edits against already issued native byte ceilings.
// Revocation remains immediate at the next bounded lease check. A lower quota or
// new calendar cannot retroactively revoke bytes already reserved by a flow.
func (s *Store) PutServicePlan(v service.Plan) error {
	if e := validateServicePlan(v); e != nil {
		return e
	}
	return s.putBudgetPolicy("services", v.ID, v)
}
func (s *Store) PutEntitlement(v service.Entitlement) error {
	if e := validateEntitlement(v); e != nil {
		return e
	}
	return s.putBudgetPolicy("entitlements", v.UserID, v)
}
func (s *Store) putBudgetPolicy(kind, id string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	if kind == "entitlements" {
		v := value.(service.Entitlement)
		if _, _, _, e = s.policyChangeRecord(tx, service.PolicyChange{Entitlement: &v}); e != nil {
			return e
		}
	}
	if e = s.guardBudgetPolicyUpdate(tx, kind, id, value, time.Now().UTC()); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) guardBudgetPolicyUpdate(tx *sql.Tx, kind, id string, value any, now time.Time) error {
	return s.guardBudgetPolicyUpdateAt(tx, kind, id, value, now, now)
}
func (s *Store) guardBudgetPolicyUpdateAt(tx *sql.Tx, kind, id string, value any, now, anchor time.Time) error {
	active, e := s.activePolicyLimitsTx(tx, now)
	if e != nil {
		return e
	}
	budgets, e := s.listTx(tx, "admission-budgets")
	if e != nil {
		return e
	}
	type priorPolicy struct {
		policy  budgetPolicy
		cycle   service.CyclePolicy
		route   string
		rateBPS int64
	}
	prior := map[string]priorPolicy{}
	for _, raw := range budgets {
		var b admissionBudget
		if e = json.Unmarshal(raw, &b); e != nil {
			return e
		}
		if b.Closed || b.Finite && b.GrantedRaw == b.SettledRaw {
			continue
		}
		// Limits and calendar are account-wide; evaluate once per affected
		// account even when it has many outstanding logical-stream budgets.
		if _, seen := prior[b.AccountID]; seen {
			continue
		}
		effective, e := s.effectivePolicyTx(tx, b.AccountID, now)
		if e != nil {
			return e
		}
		p, e := s.admissionBudgetPolicy(tx, EntryAdmissionBinding{UserID: b.AccountID, RouteID: b.RouteID}, now)
		if e != nil {
			return e
		}
		prior[b.AccountID] = priorPolicy{p, effective.Entitlement.Cycle, b.RouteID, effective.EntryRateBPS}
	}
	if e = s.putTx(tx, kind, id, value); e != nil {
		return e
	}
	if kind == "user-groups" {
		if e = s.initializeGroupCycles(tx, value.(service.Group), anchor); e != nil {
			return e
		}
	}
	if e = s.guardActivePolicyLimits(tx, active, now); e != nil {
		return e
	}
	for user, before := range prior {
		after, e := s.admissionBudgetPolicy(tx, EntryAdmissionBinding{UserID: user, RouteID: before.route}, now)
		if e != nil {
			return e
		}
		effective, e := s.effectivePolicyTx(tx, user, now)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(before.cycle, effective.Entitlement.Cycle) || !before.policy.CycleStart.Equal(after.CycleStart) {
			return fmt.Errorf("cycle change overlaps issued byte budgets; stop and settle active presences first")
		}
		if effective.EntryRateBPS > 0 && (before.rateBPS == 0 || effective.EntryRateBPS < before.rateBPS) {
			return fmt.Errorf("rate reduction overlaps issued byte budgets; stop and settle active presences first")
		}
		if after.Quota > 0 && (before.policy.Quota == 0 || after.Quota < before.policy.Quota) {
			return fmt.Errorf("quota reduction overlaps issued byte budgets; stop and settle active presences first")
		}
	}
	return nil
}
