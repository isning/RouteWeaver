package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/service"
	"strings"
	"time"
)

// EntryAdmissionBinding links an authenticated public listener principal to one
// account. Transit connectors and imported client subscriptions cannot create it.
type EntryAdmissionBinding struct {
	ID                string `json:"id"`
	InstanceID        string `json:"instanceId"`
	EntryID           string `json:"entryId"`
	SubjectID         string `json:"subjectId"`
	UserID            string `json:"userId"`
	RouteID           string `json:"routeId"`
	GrantID           string `json:"grantId"`
	CredentialVersion string `json:"credentialVersion"`
}
type AdmissionScope = domain.InstanceScope
type AdmissionRequest = entrypolicy.AdmissionRequest
type AdmissionDecision = entrypolicy.Lease
type admissionLease struct {
	ID         string                `json:"id"`
	Scope      AdmissionScope        `json:"scope"`
	Binding    EntryAdmissionBinding `json:"binding"`
	ClientIP   string                `json:"clientIp"`
	PresenceID string                `json:"presenceId"`
	ExpiresAt  time.Time             `json:"expiresAt"`
}
type admissionGrant struct {
	PublishedRouteID  string            `json:"publishedRouteId"`
	SubjectID         string            `json:"subjectId"`
	DeploymentID      string            `json:"deploymentId"`
	Connection        domain.Connection `json:"connection"`
	ID                string            `json:"id"`
	UserID            string            `json:"userId"`
	RouteID           string            `json:"routeId"`
	CredentialVersion string            `json:"credentialVersion"`
	Revoked           bool              `json:"revoked"`
}

func admissionBindingKey(instance, entry, subject, version string) string {
	return strings.Join([]string{instance, entry, subject, version}, ":")
}
func (s *Store) SetEntryAdmissionBinding(v EntryAdmissionBinding) error {
	record, e := EntryAdmissionBindingRecord(v)
	if e != nil {
		return e
	}
	var endpoint domain.ManagedEndpoint
	if e := s.Get("managed-endpoints", v.EntryID, &endpoint); e != nil {
		return e
	}
	if endpoint.InstanceID != v.InstanceID {
		return fmt.Errorf("entry belongs to another instance")
	}
	var instance domain.CoreInstance
	if e := s.Get("core-instances", v.InstanceID, &instance); e != nil {
		return e
	}
	var grant admissionGrant
	if e := s.TenantGet(v.UserID, "platform-entries", v.GrantID, &grant); e != nil {
		return e
	}
	if grant.Revoked || grant.UserID != v.UserID || grant.RouteID != v.RouteID || grant.CredentialVersion != v.CredentialVersion {
		return fmt.Errorf("entry binding requires the current owned public credential grant")
	}
	if instance.AdapterID == "routeweaver/managed-xray" && (grant.PublishedRouteID != v.RouteID || grant.SubjectID != v.SubjectID || grant.DeploymentID == "") {
		return fmt.Errorf("managed entry requires its published principal grant; legacy grants cannot activate it")
	}
	return s.PutImmutable(record.Kind, record.ID, record.Value)
}
func (s *Store) listTx(tx *sql.Tx, kind string) ([]json.RawMessage, error) {
	rows, e := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, kind)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			return nil, e
		}
		var raw json.RawMessage
		if e = s.open(kind, id, b, &raw); e != nil {
			return nil, e
		}
		out = append(out, raw)
	}
	return out, rows.Err()
}
func (s *Store) admissionScopeCurrent(tx *sql.Tx, scope AdmissionScope, now time.Time) (bool, error) {
	var enrollment struct {
		Scope     AdmissionScope `json:"scope"`
		ExpiresAt time.Time      `json:"expiresAt"`
		Revoked   bool           `json:"revoked"`
	}
	if e := s.getTx(tx, "instance-enrollments", scope.InstanceID, &enrollment); e == ErrNotFound {
		return false, nil
	} else if e != nil {
		return false, e
	}
	return enrollment.Scope == scope && !enrollment.Revoked && now.Before(enrollment.ExpiresAt), nil
}

// admissionEligibility reads the same canonical usage ledger and cycle policy as
// subscription eligibility, inside the transaction that claims the IP slot.
func (s *Store) admissionEligibility(tx *sql.Tx, binding EntryAdmissionBinding, now time.Time) (reason string, ipLimit int, connectionLimit int, rateBPS int64, expires *time.Time, err error) {
	var user domain.User
	if err = s.getTx(tx, "users", binding.UserID, &user); err != nil {
		return
	}
	if !user.Enabled {
		reason = "disabled"
		return
	}
	var account Account
	if err = s.getTx(tx, "accounts", binding.UserID, &account); err == nil && account.Disabled {
		reason = "disabled"
		return
	} else if err != nil && err != ErrNotFound {
		return
	}
	err = nil
	var grant admissionGrant
	if err = s.getTx(tx, TenantKind(binding.UserID, "platform-entries"), binding.GrantID, &grant); err == ErrNotFound {
		err = nil
		reason = "credential-revoked"
		return
	} else if err != nil {
		return
	}
	if grant.Revoked || grant.CredentialVersion != binding.CredentialVersion || grant.UserID != binding.UserID || grant.RouteID != binding.RouteID {
		reason = "credential-revoked"
		return
	}
	var instance domain.CoreInstance
	if err = s.getTx(tx, "core-instances", binding.InstanceID, &instance); err != nil {
		return
	}
	if instance.AdapterID == "routeweaver/managed-xray" && (grant.PublishedRouteID != binding.RouteID || grant.SubjectID != binding.SubjectID || grant.DeploymentID == "") {
		reason = "deployment-unverified"
		return
	}
	if current, until, e := s.admissionManifestCurrent(tx, binding, grant, now); e != nil {
		err = e
		return
	} else if !current {
		reason = "deployment-unverified"
		return
	} else {
		expires = until
	}
	policy, e := s.effectivePolicyTx(tx, user.ID, now)
	if e != nil {
		err = e
		return
	}
	entitlement := policy.Entitlement
	if policy.Status != "active" {
		reason = policy.Status
		return
	}
	if entitlement.ExpiresAt != nil {
		expires = earlier(expires, *entitlement.ExpiresAt)
	}
	quota := policy.QuotaBytes
	ipLimit = policy.OnlineIPLimit
	connectionLimit = policy.ConnectionLimit
	rateBPS = policy.EntryRateBPS
	if !policy.AllowsRoute(binding.RouteID) {
		reason = "route-not-entitled"
		return
	}
	var holds []json.RawMessage
	if holds, err = s.listTx(tx, "accounting-holds"); err != nil {
		return
	}
	for _, raw := range holds {
		var hold AccountingHold
		if err = json.Unmarshal(raw, &hold); err != nil {
			return
		}
		if hold.UserID == user.ID {
			reason = "accounting-pending"
			return
		}
	}
	var window service.CycleWindow
	if window, err = entitlement.Cycle.Window(now); err != nil {
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
		if reset.UserID == user.ID && reset.At.After(window.Start) && !reset.At.After(now) {
			window.Start = reset.At
		}
	}
	var usage service.UsageTotals
	end := time.Time{}
	if window.NextReset != nil {
		end = *window.NextReset
	}
	if usage, err = s.currentUsageTx(tx, user.ID, window.Start, end); err != nil {
		return
	}
	if quota > 0 && usage.WeightedBytes >= quota {
		reason = "exhausted"
		return
	}

	return
}

// AcquireAdmission grants a short, scoped presence lease. All active leases for
// the stable account form one normalized IP union, across nodes and entries.
// SQL serializes the eligibility check and IP slot claim. Existing IPs can renew
// at the cap; a new IP cannot displace an already admitted one.
func (s *Store) AcquireAdmission(scope AdmissionScope, in AdmissionRequest, now time.Time) (AdmissionDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	decision := AdmissionDecision{}
	for _, id := range []string{in.EntryID, in.SubjectID, in.CredentialVersion, in.PresenceID} {
		if !domain.ValidID(id) {
			return decision, fmt.Errorf("valid admission identities required")
		}
	}
	ip, e := netip.ParseAddr(in.ClientIP)
	if e != nil || ip.Zone() != "" {
		return decision, fmt.Errorf("actual client IP address required")
	}
	ip = ip.Unmap()
	if ip.IsUnspecified() || ip.IsMulticast() || ip.String() == "255.255.255.255" {
		return decision, fmt.Errorf("actual client IP address required")
	}
	canonical := ip.String()
	tx, e := s.db.Begin()
	if e != nil {
		return decision, e
	}
	defer tx.Rollback()
	// Obtain SQLite's write reservation before reading the union. This prevents
	// two Store handles from both observing an available last slot.
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return decision, e
	}
	current, e := s.admissionScopeCurrent(tx, scope, now)
	if e != nil {
		return decision, e
	}
	if !current {
		decision.Reason = "enrollment-revoked"
		return decision, nil
	}
	var binding EntryAdmissionBinding
	e = s.getTx(tx, "entry-admission-bindings", admissionBindingKey(scope.InstanceID, in.EntryID, in.SubjectID, in.CredentialVersion), &binding)
	if e == ErrNotFound {
		decision.Reason = "entry-not-bound"
		return decision, nil
	} else if e != nil {
		return decision, e
	}
	decision.AccountID = binding.UserID
	decision.RouteID = binding.RouteID
	identity, _ := json.Marshal(struct {
		Scope      AdmissionScope
		PresenceID string
	}{scope, in.PresenceID})
	sum := sha256.Sum256(identity)
	leaseID := hex.EncodeToString(sum[:])
	decision.LeaseID = leaseID
	var previous admissionLease
	if e = s.getTx(tx, "entry-admission-leases", leaseID, &previous); e == nil {
		if previous.Binding != binding || previous.ClientIP != canonical {
			return decision, ErrConflict
		}
	} else if e != ErrNotFound {
		return decision, e
	}
	var budget admissionBudget
	if e = s.getTx(tx, "admission-budgets", leaseID, &budget); e == nil {
		if e = s.settleAdmissionBudget(tx, &budget, in, now); e != nil {
			if e == ErrAdmissionEvidence {
				if err := s.recordAdmissionAnomaly(tx, scope, binding, leaseID, in, now); err != nil {
					return decision, err
				}
				if err := tx.Commit(); err != nil {
					return decision, err
				}
			}
			return decision, e
		}
	} else if e != ErrNotFound {
		return decision, e
	} else if in.AdmittedBytes != 0 {
		if e = s.recordAdmissionAnomaly(tx, scope, binding, leaseID, in, now); e != nil {
			return decision, e
		}
		if e = tx.Commit(); e != nil {
			return decision, e
		}
		return decision, ErrAdmissionEvidence
	} else if in.Final {
		budget = admissionBudget{LeaseID: leaseID, AccountID: binding.UserID, RouteID: binding.RouteID, Closed: true, IssuedAt: now, ExpiresAt: now, LastSettlement: now}
		if e = s.putTx(tx, "admission-budgets", leaseID, budget); e != nil {
			return decision, e
		}
		previous = admissionLease{ID: leaseID, Scope: scope, Binding: binding, ClientIP: canonical, PresenceID: in.PresenceID, ExpiresAt: now}
	}
	deny := func(reason string) (AdmissionDecision, error) { decision.Reason = reason; return decision, tx.Commit() }
	if in.Final {
		previous.ExpiresAt = now
		if e = s.putTx(tx, "entry-admission-leases", leaseID, previous); e != nil {
			return decision, e
		}
		return deny("presence-closed")
	}
	reason, cap, connectionCap, rate, expiry, e := s.admissionEligibility(tx, binding, now)
	if e != nil {
		return decision, e
	}
	decision.EntryRateBPS = rate
	if reason != "" {
		return deny(reason)
	}
	ips, presences, e := s.admissionLivePresencesTx(tx, binding.UserID, now)
	if e != nil {
		return decision, e
	}
	if !ips[canonical] && cap > 0 && len(ips) >= cap {
		return deny("ip-limit")
	}
	existing := previous.ID != "" && now.Before(previous.ExpiresAt)
	if connectionCap > 0 && presences >= connectionCap && !existing {
		return deny("connection-limit")
	}
	if presences >= 4096 && !existing {
		return deny("presence-capacity")
	}
	until := now.Add(entrypolicy.MaxLease)
	var enrollment struct {
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if e = s.getTx(tx, "instance-enrollments", scope.InstanceID, &enrollment); e != nil {
		return decision, e
	}
	if enrollment.ExpiresAt.Before(until) {
		until = enrollment.ExpiresAt
	}
	if expiry != nil && expiry.Before(until) {
		until = *expiry
	}
	ceiling, reason, e := s.grantAdmissionBudget(tx, binding, leaseID, &budget, now, until)
	if e != nil {
		return decision, e
	}
	if reason != "" {
		return deny(reason)
	}
	until = budget.ExpiresAt
	decision.ByteBudget = ceiling
	lease := admissionLease{ID: leaseID, Scope: scope, Binding: binding, ClientIP: canonical, PresenceID: in.PresenceID, ExpiresAt: until}
	if e = s.putTx(tx, "entry-admission-leases", leaseID, lease); e != nil {
		return decision, e
	}
	if e = tx.Commit(); e != nil {
		return decision, e
	}
	decision.Allowed = true
	decision.LeaseID = leaseID
	decision.ExpiresAt = until
	return decision, nil
}
func (s *Store) ReleaseAdmission(scope AdmissionScope, leaseID string, now time.Time) error {
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
	current, e := s.admissionScopeCurrent(tx, scope, now)
	if e != nil {
		return e
	}
	if !current {
		return ErrConflict
	}
	var lease admissionLease
	if e = s.getTx(tx, "entry-admission-leases", leaseID, &lease); e == ErrNotFound {
		return nil
	} else if e != nil {
		return e
	}
	if lease.Scope != scope {
		return ErrConflict
	}
	lease.ExpiresAt = now
	if e = s.putTx(tx, "entry-admission-leases", leaseID, lease); e != nil {
		return e
	}
	return tx.Commit()
}
