package store

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"time"
)

// ServicePolicyFence is a bounded, reviewed policy snapshot plus the earliest
// receipt/enrollment/authorization deadline. It is checked by the SQLite writer
// transaction immediately before commit, not by an earlier unlocked read.
type ServicePolicyCheck struct {
	Policy   service.EffectivePolicy
	RouteIDs []string
}
type ServicePolicyFence struct {
	Checks     []ServicePolicyCheck
	ValidUntil time.Time
}

func (s *Store) CompareServicePolicyAndPutRecords(fence ServicePolicyFence, compares []RecordCompare, sets []RecordSetCompare, writes []RecordWrite) error {
	return s.compareSetsAndPutRecords(compares, sets, writes, &fence)
}
func (s *Store) CompareServicePolicyAndGenerateRecord(fence ServicePolicyFence, kind, id string, compares []RecordCompare, sets []RecordSetCompare, build func(uint64) (any, []RecordWrite, error)) (uint64, error) {
	return s.compareSetsAndGenerateRecord(kind, id, compares, sets, build, &fence)
}
func (s *Store) checkServicePolicyFenceTx(tx *sql.Tx, fence ServicePolicyFence) error {
	now := time.Now().UTC()
	if fence.ValidUntil.IsZero() || !now.Before(fence.ValidUntil) || len(fence.Checks) > 1000 {
		return ErrConflict
	}
	seen := map[string]bool{}
	for _, check := range fence.Checks {
		id := check.Policy.UserID
		if !domain.ValidID(id) || seen[id] || len(check.RouteIDs) == 0 || len(check.RouteIDs) > 1000 {
			return ErrConflict
		}
		seen[id] = true
		if expiry := check.Policy.Entitlement.ExpiresAt; expiry != nil && expiry.Before(fence.ValidUntil) {
			fence.ValidUntil = *expiry
		}
		actual, err := s.effectivePolicyTx(tx, id, now)
		if err != nil {
			return err
		}
		if actual.Status != "active" || !reflect.DeepEqual(actual, check.Policy) {
			return ErrConflict
		}
		for _, route := range check.RouteIDs {
			if !domain.ValidID(route) || !actual.AllowsRoute(route) {
				return ErrConflict
			}
		}
		reason, err := s.policyUsageEligibilityTx(tx, actual, now)
		if err != nil {
			return err
		}
		if reason != "" {
			return ErrConflict
		}
		hold, err := s.unresolvedBudgetHoldTx(tx, id, now)
		if err != nil {
			return err
		}
		if hold {
			return ErrConflict
		}
	}
	// The bounded check itself can cross a short receipt deadline.
	if !time.Now().UTC().Before(fence.ValidUntil) {
		return ErrConflict
	}
	return nil
}

// Shared with admissionEligibility: do not invent a second quota/cycle/hold
// evaluator for service renewal. currentUsageTx uses the canonical ledger and
// its verified projection under the same reserved writer transaction.
func (s *Store) policyUsageEligibilityTx(tx *sql.Tx, policy service.EffectivePolicy, now time.Time) (reason string, err error) {
	var holds []json.RawMessage
	if holds, err = s.listTx(tx, "accounting-holds"); err != nil {
		return
	}
	for _, raw := range holds {
		var hold AccountingHold
		if err = json.Unmarshal(raw, &hold); err != nil {
			return
		}
		if hold.UserID == policy.UserID {
			reason = "accounting-pending"
			return
		}
	}
	var window service.CycleWindow
	if window, err = policy.Entitlement.Cycle.Window(now); err != nil {
		return
	}
	// Reversible safety hold: a future window cannot account for bytes used
	// now. Preserve the calendar and ledger; pre-anchor consumption treatment
	// requires an explicit product/migration decision, not an implicit reset.
	if policy.QuotaBytes > 0 && window.Start.After(now) {
		reason = "accounting-pending"
		return
	}
	var resets []json.RawMessage
	if resets, err = s.listTx(tx, "resets"); err != nil {
		return
	}
	for _, raw := range resets {
		var reset Reset
		if err = json.Unmarshal(raw, &reset); err != nil {
			return
		}
		if reset.UserID == policy.UserID && reset.At.After(window.Start) && !reset.At.After(now) {
			window.Start = reset.At
		}
	}
	var usage service.UsageTotals
	end := time.Time{}
	if window.NextReset != nil {
		end = *window.NextReset
	}
	if usage, err = s.currentUsageTx(tx, policy.UserID, window.Start, end); err != nil {
		return
	}
	if policy.QuotaBytes > 0 && usage.WeightedBytes >= policy.QuotaBytes {
		reason = "exhausted"
		return
	}
	return
}
