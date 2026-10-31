package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"sort"
	"time"
)

func (s *Store) effectivePolicyTx(tx *sql.Tx, userID string, now time.Time) (service.EffectivePolicy, error) {
	var user domain.User
	if e := s.getTx(tx, "users", userID, &user); e != nil {
		return service.EffectivePolicy{}, e
	}
	input := service.PolicyInput{UserID: userID, Enabled: user.Enabled, QuotaBytes: user.QuotaBytes, Entitlement: service.Entitlement{UserID: userID, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}}
	var account struct {
		Disabled bool `json:"disabled"`
	}
	if e := s.getTx(tx, "accounts", userID, &account); e == nil {
		input.Enabled = input.Enabled && !account.Disabled
	} else if e != ErrNotFound {
		return service.EffectivePolicy{}, e
	}
	if e := s.getTx(tx, "entitlements", userID, &input.Entitlement); e != nil && e != ErrNotFound {
		return service.EffectivePolicy{}, e
	}
	for _, kind := range []string{"services", "user-groups", "routes"} {
		records, e := s.listTx(tx, kind)
		if e != nil {
			return service.EffectivePolicy{}, e
		}
		for _, raw := range records {
			switch kind {
			case "services":
				var v service.Plan
				if e = json.Unmarshal(raw, &v); e != nil {
					return service.EffectivePolicy{}, e
				}
				input.Plans = append(input.Plans, v)
			case "user-groups":
				var v service.Group
				if e = json.Unmarshal(raw, &v); e != nil {
					return service.EffectivePolicy{}, e
				}
				input.Groups = append(input.Groups, v)
			case "routes":
				var v domain.Route
				if e = json.Unmarshal(raw, &v); e != nil {
					return service.EffectivePolicy{}, e
				}
				for _, id := range v.UserIDs {
					if id == userID {
						input.DirectRouteIDs = append(input.DirectRouteIDs, v.ID)
					}
				}
			}
		}
	}
	return service.ResolvePolicy(input, now), nil
}

// EffectivePolicy reads one consistent policy snapshot. All eligibility callers
// use the same pure evaluator as the admission writer transaction.
func (s *Store) EffectivePolicy(userID string, now time.Time) (service.EffectivePolicy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return service.EffectivePolicy{}, e
	}
	defer tx.Rollback()
	return s.effectivePolicyTx(tx, userID, now)
}

func (s *Store) policySnapshot(tx *sql.Tx, now time.Time) (string, map[string]service.EffectivePolicy, error) {
	h := sha256.New()
	users := []string{}
	for _, kind := range []string{"users", "accounts", "services", "entitlements", "user-groups", "routes", "published-routes"} {
		raw, e := s.listTx(tx, kind)
		if e != nil {
			return "", nil, e
		}
		h.Write([]byte(kind))
		for _, v := range raw {
			h.Write(v)
			h.Write([]byte{0})
			if kind == "users" {
				var user domain.User
				if e = json.Unmarshal(v, &user); e != nil {
					return "", nil, e
				}
				users = append(users, user.ID)
			}
		}
	}
	out := map[string]service.EffectivePolicy{}
	for _, id := range users {
		p, e := s.effectivePolicyTx(tx, id, now)
		if e != nil {
			return "", nil, e
		}
		out[id] = p
	}
	return hex.EncodeToString(h.Sum(nil)), out, nil
}

func validateEntitlement(v service.Entitlement) error {
	if !domain.ValidID(v.UserID) || v.QuotaOverride != nil && *v.QuotaOverride < 0 || v.OnlineIPLimitOverride != nil && *v.OnlineIPLimitOverride < 0 || v.ConnectionLimitOverride != nil && *v.ConnectionLimitOverride < 0 || v.EntryRateBPSOverride != nil && *v.EntryRateBPSOverride < 0 {
		return fmt.Errorf("invalid entitlement limits")
	}
	if v.ExpiresAt != nil && !v.ExpiresAt.After(v.StartsAt) {
		return fmt.Errorf("expiry must follow service start")
	}
	if v.RouteIDsOverride != nil {
		for _, id := range *v.RouteIDsOverride {
			if !domain.ValidID(id) {
				return fmt.Errorf("invalid route override")
			}
		}
	}
	return v.Cycle.Validate()
}
func validateServicePlan(v service.Plan) error {
	if !domain.ValidID(v.ID) || v.Name == "" || v.QuotaBytes < 0 || v.OnlineIPLimit < 0 || v.ConnectionLimit < 0 || v.EntryRateBPS < 0 {
		return fmt.Errorf("invalid service plan")
	}
	return nil
}

func (s *Store) policyChangeRecord(tx *sql.Tx, change service.PolicyChange) (string, string, any, error) {
	count := 0
	if change.Service != nil {
		count++
	}
	if change.Group != nil {
		count++
	}
	if change.Entitlement != nil {
		count++
	}
	if count != 1 {
		return "", "", nil, fmt.Errorf("exactly one service, group or entitlement change required")
	}
	if v := change.Service; v != nil {
		if e := validateServicePlan(*v); e != nil {
			return "", "", nil, e
		}
		candidate := *v
		if candidate.Cycle.Mode == "" {
			candidate.Cycle.Mode = "none"
		}
		validateCycle := candidate.Cycle
		if validateCycle.Anchor.IsZero() {
			validateCycle.Anchor = time.Unix(0, 0).UTC()
		}
		if e := validateCycle.Validate(); e != nil {
			return "", "", nil, e
		}
		if e := s.validatePolicyRoutes(tx, candidate.RouteIDs); e != nil {
			return "", "", nil, e
		}
		return "services", v.ID, candidate, nil
	}
	if v := change.Entitlement; v != nil {
		if e := validateEntitlement(*v); e != nil {
			return "", "", nil, e
		}
		var u domain.User
		if e := s.getTx(tx, "users", v.UserID, &u); e != nil {
			return "", "", nil, e
		}
		if v.ServiceID != "" {
			var plan service.Plan
			if e := s.getTx(tx, "services", v.ServiceID, &plan); e != nil {
				return "", "", nil, fmt.Errorf("unknown service")
			}
		}
		if v.RouteIDsOverride != nil {
			if e := s.validatePolicyRoutes(tx, *v.RouteIDsOverride); e != nil {
				return "", "", nil, e
			}
		}
		return "entitlements", v.UserID, *v, nil
	}
	v := *change.Group
	if !domain.ValidID(v.ID) || v.Name == "" || !domain.ValidID(v.ServiceID) {
		return "", "", nil, fmt.Errorf("group identity, name and service required")
	}
	var plan service.Plan
	if e := s.getTx(tx, "services", v.ServiceID, &plan); e != nil {
		return "", "", nil, fmt.Errorf("unknown group service")
	}
	seen := map[string]bool{}
	members := []string{}
	for _, id := range v.MemberIDs {
		if !domain.ValidID(id) {
			return "", "", nil, fmt.Errorf("invalid member")
		}
		var u domain.User
		if e := s.getTx(tx, "users", id, &u); e != nil {
			return "", "", nil, fmt.Errorf("unknown group member %s", id)
		}
		if !seen[id] {
			seen[id] = true
			members = append(members, id)
		}
	}
	sort.Strings(members)
	v.MemberIDs = members
	return "user-groups", v.ID, v, nil
}

// A first group assignment initializes an account calendar once. Later group or
// plan changes never rewrite an existing calendar or start a fresh quota period.
func (s *Store) initializeGroupCycles(tx *sql.Tx, group service.Group, now time.Time) error {
	for _, id := range group.MemberIDs {
		var ent service.Entitlement
		e := s.getTx(tx, "entitlements", id, &ent)
		if e == nil {
			continue
		}
		if e != ErrNotFound {
			return e
		}
		p, e := s.effectivePolicyTx(tx, id, now)
		if e != nil {
			return e
		}
		if p.Service == nil {
			continue
		}
		cycle := p.Service.Cycle
		if cycle.Mode == "" {
			cycle.Mode = "none"
		}
		cycle.Anchor = now
		cycle.Timezone = "UTC+8"
		historical, e := s.hasAccountPolicyHistoryTx(tx, id)
		if e != nil {
			return e
		}
		if historical {
			// Before explicit entitlements existed, a direct user's calendar
			// was no-reset from the beginning of its ledger. First membership
			// must not turn already settled usage into a fresh quota period.
			cycle = service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}
		}
		ent = service.Entitlement{UserID: id, StartsAt: now, Cycle: cycle}
		if e = validateEntitlement(ent); e != nil {
			return e
		}
		if e = s.putTx(tx, "entitlements", id, ent); e != nil {
			return e
		}
	}
	return nil
}

func (s *Store) policyChange(change service.PolicyChange, revision string, now time.Time, commit bool, expected *service.PolicyEditPrecondition) (service.PolicyPreview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := service.PolicyPreview{Affected: []service.PolicyEffect{}, Blockers: []string{}}
	tx, e := s.db.Begin()
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return out, e
	}
	var opened *service.PolicyEditContext
	if expected != nil {
		// PreviewPolicyEdit resolves only the exact target first. Fence its
		// opening content before old draft references can obscure a conflict.
		target, err := policyEditTarget(change)
		if err != nil {
			return out, err
		}
		context, err := s.policyEditContextTx(tx, target)
		if err != nil {
			return out, err
		}
		if err := checkPolicyEditPrecondition(*expected, context.Precondition); err != nil {
			return out, err
		}
		opened = &context
		out.Guard = "opened-record"
	}
	kind, id, value, e := s.policyChangeRecord(tx, change)
	if e != nil {
		return out, e
	}
	// Entitlement resource review is guarded-preview-only until its UI migrates.
	// Raw replacement and the existing apply response keep their legacy shape.
	if kind == "services" || kind == "user-groups" || kind == "entitlements" && expected != nil {
		if opened == nil {
			target, err := policyEditTarget(change)
			if err != nil {
				return out, err
			}
			context, err := s.policyEditContextTx(tx, target)
			if err != nil {
				// Legacy deliberate replacement keeps its established behavior for
				// unsupported old shapes. Guarded editors never discard unknown data.
				if !errors.Is(err, ErrPolicyEditUnsupportedRecord) {
					return out, err
				}
			} else {
				opened = &context
			}
		}
		if opened != nil {
			var after service.PolicyChange
			switch candidate := value.(type) {
			case service.Plan:
				after.Service = &candidate
			case service.Group:
				after.Group = &candidate
			case service.Entitlement:
				after.Entitlement = &candidate
			}
			out.Resource = &service.PolicyResourceReview{Target: opened.Target, Before: opened.Record, After: after}
			if kind == "user-groups" {
				// Baseline and candidate validation have already succeeded. Both
				// label sides are read before simulation in this same transaction;
				// policySnapshot already binds their user/service source records.
				beforeLabels, err := s.groupPolicyReferenceLabelsTx(tx, opened.Record)
				if err != nil {
					return out, err
				}
				afterLabels, err := s.groupPolicyReferenceLabelsTx(tx, &after)
				if err != nil {
					return out, err
				}
				out.Resource.References = &service.PolicyResourceReferences{Before: beforeLabels, After: afterLabels}
			}
		}
	}
	encoded, e := json.Marshal(struct {
		Kind  string
		ID    string
		Value any
	}{kind, id, value})
	if e != nil {
		return out, e
	}
	digest := sha256.Sum256(encoded)
	beforeRevision, before, e := s.policySnapshot(tx, now)
	if e != nil {
		return out, e
	}
	ticket := policyPreviewTicket{Snapshot: beforeRevision, Change: hex.EncodeToString(digest[:]), PreparedAt: now}
	if kind == "user-groups" {
		ticket.InitialCalendars = map[string]bool{}
		for _, user := range value.(service.Group).MemberIDs {
			var ent service.Entitlement
			e = s.getTx(tx, "entitlements", user, &ent)
			if e == ErrNotFound {
				historical, err := s.hasAccountPolicyHistoryTx(tx, user)
				if err != nil {
					return out, err
				}
				ticket.InitialCalendars[user] = historical
			} else if e != nil {
				return out, e
			}
		}
	}
	if commit {
		raw, e := base64.RawURLEncoding.DecodeString(revision)
		if e != nil {
			return out, ErrConflict
		}
		var reviewed policyPreviewTicket
		if e = s.open("policy-preview", "v1", raw, &reviewed); e != nil {
			return out, ErrConflict
		}
		if reviewed.Snapshot != ticket.Snapshot || reviewed.Change != ticket.Change || !reflect.DeepEqual(reviewed.InitialCalendars, ticket.InitialCalendars) || reviewed.PreparedAt.After(now) || now.Sub(reviewed.PreparedAt) > 24*time.Hour {
			return out, ErrConflict
		}
		ticket = reviewed
		out.Revision = revision
	} else {
		raw, e := s.seal("policy-preview", "v1", ticket)
		if e != nil {
			return out, e
		}
		out.Revision = base64.RawURLEncoding.EncodeToString(raw)
	}
	// The same budget guard is used by compatibility endpoints and preview/apply.
	if e = s.guardBudgetPolicyUpdateAt(tx, kind, id, value, now, ticket.PreparedAt); e != nil {
		out.Blockers = append(out.Blockers, e.Error())
		if commit {
			return out, e
		}
	}
	_, after, e := s.policySnapshot(tx, now)
	if e != nil {
		return out, e
	}
	ids := []string{}
	for user := range before {
		ids = append(ids, user)
	}
	sort.Strings(ids)
	for _, user := range ids {
		if !reflect.DeepEqual(before[user], after[user]) {
			out.Affected = append(out.Affected, service.PolicyEffect{UserID: user, Before: before[user], After: after[user]})
			if after[user].Status == "ambiguous" || after[user].Status == "service-missing" {
				out.Blockers = append(out.Blockers, fmt.Sprintf("user %s has %s authorization", user, after[user].Status))
			}
		}
	}
	if commit {
		if len(out.Blockers) > 0 {
			return out, fmt.Errorf("policy change blocked: %s", out.Blockers[0])
		}
		if e = tx.Commit(); e != nil {
			return out, e
		}
	}
	return out, nil
}
func (s *Store) PreviewPolicyChange(change service.PolicyChange, now time.Time) (service.PolicyPreview, error) {
	return s.policyChange(change, "", now, false, nil)
}
func (s *Store) ApplyPolicyChange(change service.PolicyChange, revision string, now time.Time) (service.PolicyPreview, error) {
	return s.policyChange(change, revision, now, true, nil)
}

// The opaque AEAD preview token binds both the exact normalized change and the
// original policy snapshot, including a stable first-assignment cycle anchor.
type policyPreviewTicket struct {
	Snapshot         string
	Change           string
	PreparedAt       time.Time
	InitialCalendars map[string]bool
}

func (s *Store) validatePolicyRoutes(tx *sql.Tx, ids []string) error {
	for _, id := range ids {
		var raw json.RawMessage
		e := s.getTx(tx, "routes", id, &raw)
		if e == nil {
			continue
		}
		if e != ErrNotFound {
			return e
		}
		e = s.getTx(tx, "published-routes", id, &raw)
		if e == nil {
			continue
		}
		if e != ErrNotFound {
			return e
		}
		return fmt.Errorf("unknown authorization route %s", id)
	}
	return nil
}

func (s *Store) hasAccountPolicyHistoryTx(tx *sql.Tx, user string) (bool, error) {
	for _, kind := range []string{"ledger", "admission-budgets", "resets"} {
		records, e := s.listTx(tx, kind)
		if e != nil {
			return false, e
		}
		for _, raw := range records {
			var owner struct {
				UserID    string `json:"userId"`
				AccountID string `json:"accountId"`
			}
			if e = json.Unmarshal(raw, &owner); e != nil {
				return false, e
			}
			if owner.UserID == user || owner.AccountID == user {
				return true, nil
			}
		}
	}
	return false, nil
}
