package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"math"
	"net/http"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"sort"
	"time"
)

type serviceIntent struct {
	ID                  string                         `json:"id"`
	BatchID             string                         `json:"batchId"`
	ActorID             string                         `json:"actorId"`
	AuthorityDigest     string                         `json:"authorityDigest,omitempty"`
	Current             controlprotocol.Identity       `json:"current"`
	Running             bool                           `json:"running"`
	Status              string                         `json:"status"`
	AutomaticAttempts   int                            `json:"automaticAttempts"`
	NextAttemptAt       time.Time                      `json:"nextAttemptAt,omitempty"`
	FailedGeneration    uint64                         `json:"failedGeneration,string"`
	ValidationNotBefore time.Time                      `json:"validationNotBefore,omitempty"`
	Sequence            uint64                         `json:"sequence,string"`
	Lease               controlprotocol.PolicyLease    `json:"lease"`
	PendingRefresh      *controlprotocol.PolicyRefresh `json:"pendingRefresh,omitempty"`
}
type serviceReceipt struct {
	Heartbeat  controlprotocol.ServiceHeartbeat `json:"heartbeat"`
	ReceivedAt time.Time                        `json:"receivedAt"`
}
type serviceRecovery struct {
	Intent  serviceIntent
	Receipt serviceReceipt
}

func (h *server) serviceIntentView(id string, current controlprotocol.Identity) (map[string]any, error) {
	var intent serviceIntent
	if e := h.s.Get("agent-service-intents", id, &intent); e == store.ErrNotFound {
		return nil, nil
	} else if e != nil {
		return nil, e
	}
	running, status := intent.Running, intent.Status
	if intent.Current != current {
		running = false
		status = "superseded"
	}
	return map[string]any{"id": intent.ID, "running": running, "status": status, "automaticAttempts": intent.AutomaticAttempts, "nextAttemptAt": intent.NextAttemptAt, "leaseExpiresAt": intent.Lease.ExpiresAt}, nil
}
func (h *server) checkServiceAuthority(p *preparedFleet, intent serviceIntent) error {
	if intent.ActorID == "operator" {
		if len(h.opts.AdminToken) < 32 || intent.AuthorityDigest == "" || intent.AuthorityDigest != auth.Digest(h.opts.AdminToken) {
			return fmt.Errorf("service operator authority changed")
		}
		return nil
	}
	var account struct {
		Role                   string `json:"role"`
		Disabled               bool   `json:"disabled"`
		Retired                bool   `json:"retired"`
		PasswordChangeRequired bool   `json:"passwordChangeRequired"`
	}
	if e := h.fleetRead(p, "accounts", intent.ActorID, &account, false); e != nil {
		return e
	}
	if account.Disabled || account.Retired || account.PasswordChangeRequired || account.Role != "admin" {
		return fmt.Errorf("service administrator authority revoked")
	}
	return nil
}
func (h *server) registerServiceHeartbeat(r chi.Router) {
	r.Post("/agent/instances/{instanceId}/service-heartbeat", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var fact controlprotocol.ServiceHeartbeat
		if !decode(w, r, &fact) {
			return
		}
		now := time.Now().UTC()
		if !fact.ServiceActive || fact.Desired.Scope != enrollment.Scope || !fact.Observed.Known || !fact.Observed.Quiescent || fact.Observed.ObservedAt.IsZero() || fact.Observed.ObservedAt.Before(now.Add(-15*time.Second)) || fact.Observed.ObservedAt.After(now.Add(5*time.Second)) || (fact.Observed.Generation == 0 && fact.Observed.Identity != (controlprotocol.Identity{})) || (fact.Observed.Generation != 0 && fact.Observed.Identity != fact.Desired) {
			fail(w, 409, "fresh known runtime observation required")
			return
		}
		result, e := h.processServiceHeartbeat(enrollment, fact, now)
		if e != nil {
			fail(w, 409, "continuous service requires current authority and observation")
			return
		}
		if result.PolicyRefresh == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, 200, result)
	})
}
func (h *server) processServiceHeartbeat(enrollment Enrollment, fact controlprotocol.ServiceHeartbeat, now time.Time) (controlprotocol.ServiceHeartbeatResult, error) {
	result := controlprotocol.ServiceHeartbeatResult{}
	var desired controlprotocol.Desired
	var intent serviceIntent
	if e := h.s.Get("agent-desired", enrollment.Scope.InstanceID, &desired); e != nil {
		return result, e
	}
	if desired.Identity() != fact.Desired {
		return result, fmt.Errorf("superseded desired")
	}
	if e := h.s.Get("agent-service-intents", desired.InstanceID, &intent); e == store.ErrNotFound {
		return result, nil
	} else if e != nil {
		return result, e
	}
	if !intent.Running || intent.Current != desired.Identity() || intent.Status == "review_required" || intent.Status == "crash_loop_blocked" {
		return result, nil
	}
	if desired.Action != "start" && desired.Action != "configure" {
		return result, fmt.Errorf("not a running intent")
	}
	if now.Before(intent.Lease.IssuedAt) || (intent.PendingRefresh != nil && now.Before(intent.PendingRefresh.Lease.IssuedAt)) {
		return result, fmt.Errorf("control-plane clock precedes issued authority")
	}
	live := fact.Observed.Generation != 0
	if fact.PolicyIssuedAt != intent.Lease.IssuedAt && (intent.PendingRefresh == nil || fact.PolicyIssuedAt != intent.PendingRefresh.Lease.IssuedAt) {
		return result, fmt.Errorf("unrecognized policy receipt")
	}
	if live && intent.PendingRefresh == nil && !now.Before(intent.Lease.ExpiresAt) {
		return result, nil
	}
	// Rate-limit expensive compiler work with a durable CAS claim. A crash only
	// delays another attempt; concurrent handlers cannot issue multiple grants.
	if now.Before(intent.ValidationNotBefore) {
		return result, nil
	}
	if live && intent.PendingRefresh == nil && now.Before(intent.Lease.ExpiresAt.Add(-intent.Lease.ExpiresAt.Sub(intent.Lease.IssuedAt)/3)) {
		if intent.Status == "awaiting_observation" || intent.Status == "recovery_queued" {
			next := intent
			next.Status = "running"
			return result, h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}, {Kind: "instance-enrollments", ID: desired.InstanceID, Expected: enrollment}, {Kind: "agent-enrollments", ID: enrollment.TokenDigest, Expected: enrollment}, {Kind: "agent-service-intents", ID: desired.InstanceID, Expected: intent}}, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: next}})
		}
		return result, nil
	}
	previous := intent
	intent.ValidationNotBefore = now.Add(5 * time.Second)
	receipt := serviceReceipt{Heartbeat: fact, ReceivedAt: now}
	compares := []store.RecordCompare{{Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}, {Kind: "instance-enrollments", ID: desired.InstanceID, Expected: enrollment}, {Kind: "agent-enrollments", ID: enrollment.TokenDigest, Expected: enrollment}, {Kind: "agent-service-intents", ID: desired.InstanceID, Expected: previous}}
	if e := h.s.CompareAndPutRecords(compares, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: intent}, {Kind: "agent-service-receipts", ID: desired.InstanceID, Value: receipt}}); e != nil {
		return result, e
	}
	var record fleetRecord
	if e := h.s.Get("fleet-batches", intent.BatchID, &record); e != nil {
		return result, e
	}
	if !record.Batch.ContinuousService {
		return result, fmt.Errorf("service opt-in missing")
	}
	prepared, e := h.prepareFleet(record.Batch.Input)
	if e != nil {
		return result, h.blockService(intent, desired, "review_required")
	}
	prepared.Compares = append(prepared.Compares, store.RecordCompare{Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}, store.RecordCompare{Kind: "instance-enrollments", ID: desired.InstanceID, Expected: enrollment}, store.RecordCompare{Kind: "agent-enrollments", ID: enrollment.TokenDigest, Expected: enrollment}, store.RecordCompare{Kind: "fleet-batches", ID: intent.BatchID, Expected: record}, store.RecordCompare{Kind: "agent-service-intents", ID: desired.InstanceID, Expected: intent}, store.RecordCompare{Kind: "agent-service-receipts", ID: desired.InstanceID, Expected: receipt})
	if e = h.checkServiceAuthority(&prepared, intent); e != nil {
		return result, h.blockService(intent, desired, "review_required")
	}
	now = time.Now().UTC()
	if now.Sub(receipt.ReceivedAt) > 15*time.Second {
		return result, fmt.Errorf("service observation expired during validation")
	}
	digest, e := controlprotocol.ArtifactDigest(prepared.Artifacts[desired.InstanceID])
	if e != nil || digest != desired.Digest || record.ContinuousAuthorityHash == "" || prepared.ContinuousAuthorityHash != record.ContinuousAuthorityHash || serverFingerprint(prepared.Deployment.IR) != serverFingerprint(record.Deployment.IR) || prepared.Enrollments[desired.InstanceID] != enrollment || !now.Before(enrollment.ExpiresAt) || enrollment.Revoked {
		return result, h.blockService(intent, desired, "review_required")
	}
	deadline := receipt.ReceivedAt.Add(15 * time.Second)
	if enrollment.ExpiresAt.Before(deadline) {
		deadline = enrollment.ExpiresAt
	}
	fence := servicePolicyFence(prepared, desired.InstanceID, deadline)
	if !live {
		if intent.AutomaticAttempts >= 3 {
			return result, h.blockService(intent, desired, "crash_loop_blocked")
		}
		if intent.FailedGeneration != desired.Generation || intent.NextAttemptAt.IsZero() {
			next := intent
			next.FailedGeneration = desired.Generation
			next.NextAttemptAt = now.Add(5 * time.Second * time.Duration(1<<intent.AutomaticAttempts))
			next.Status = "recovery_backoff"
			return result, h.s.CompareServicePolicyAndPutRecords(fence, prepared.Compares, prepared.Sets, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: next}})
		}
		if now.Before(intent.NextAttemptAt) {
			return result, nil
		}
		e = h.queueFleetServiceTarget(intent.BatchID, desired.InstanceID, fmt.Sprintf("service-%s-%d", intent.ID, intent.AutomaticAttempts+1), intent.ActorID, &serviceRecovery{Intent: intent, Receipt: receipt})
		return result, e
	}
	if intent.PendingRefresh != nil {
		pending := *intent.PendingRefresh
		if !now.Before(pending.Lease.ExpiresAt) {
			return result, h.blockService(intent, desired, "review_required")
		}
		if fact.PolicyIssuedAt == pending.Lease.IssuedAt {
			if pending.Lease.ExpiresAt.Before(fence.ValidUntil) {
				fence.ValidUntil = pending.Lease.ExpiresAt
			}
			var manifest domain.PublishedManifest
			if e = h.fleetRead(&prepared, "published-manifests", desired.RevisionID, &manifest, false); e != nil {
				return result, e
			}
			next := intent
			next.Lease = pending.Lease
			next.PendingRefresh = nil
			next.Status = "running"
			manifest.PolicyExpiresAt = pending.Lease.ExpiresAt
			e = h.s.CompareServicePolicyAndPutRecords(fence, prepared.Compares, prepared.Sets, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: next}, {Kind: "published-manifests", ID: desired.RevisionID, Value: manifest}})
			return result, e
		}
		if !now.Before(intent.Lease.ExpiresAt) {
			return result, nil
		}
		if intent.Lease.ExpiresAt.Before(fence.ValidUntil) {
			fence.ValidUntil = intent.Lease.ExpiresAt
		}
		// A retry is the exact durable grant, never another sequence.
		result.PolicyRefresh = &pending
		return result, h.s.CompareServicePolicyAndPutRecords(fence, prepared.Compares, prepared.Sets, nil)
	}
	if !now.Before(intent.Lease.ExpiresAt) || intent.Sequence == math.MaxUint64 {
		return result, nil
	}
	lease := controlprotocol.PolicyLease{Revision: desired.Lease.Revision, IssuedAt: now, ExpiresAt: now.Add(time.Duration(record.Batch.LeaseSeconds) * time.Second), AccessAllowed: true, QuotaCertain: true}
	lease.ExpiresAt = serviceLeaseExpiry(prepared, desired.InstanceID, lease.ExpiresAt, now)
	if enrollment.ExpiresAt.Before(lease.ExpiresAt) {
		lease.ExpiresAt = enrollment.ExpiresAt
	}
	if !lease.IssuedAt.After(intent.Lease.IssuedAt) || !lease.ExpiresAt.After(lease.IssuedAt) {
		return result, nil
	}
	if intent.Lease.ExpiresAt.Before(fence.ValidUntil) {
		fence.ValidUntil = intent.Lease.ExpiresAt
	}
	next := intent
	next.Sequence++
	next.PendingRefresh = &controlprotocol.PolicyRefresh{Identity: desired.Identity(), IntentID: intent.ID, Sequence: next.Sequence, Lease: lease}
	e = h.s.CompareServicePolicyAndPutRecords(fence, prepared.Compares, prepared.Sets, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: next}, {Kind: "audit", ID: fmt.Sprintf("service-refresh-%s-%d", intent.ID, next.Sequence), Value: store.AuditEvent{ID: fmt.Sprintf("service-refresh-%s-%d", intent.ID, next.Sequence), ActorID: intent.ActorID, Action: "service.policy.refresh.issued", TargetID: desired.InstanceID + "/" + intent.ID, At: now}}})
	if e == nil {
		result.PolicyRefresh = next.PendingRefresh
	}
	return result, e
}
func (h *server) blockService(intent serviceIntent, desired controlprotocol.Desired, status string) error {
	next := intent
	next.Status = status
	return h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "agent-service-intents", ID: desired.InstanceID, Expected: intent}, {Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}}, []store.RecordWrite{{Kind: "agent-service-intents", ID: desired.InstanceID, Value: next}})
}

// Keep exact record CAS fences, but do not make normal login/MFA bookkeeping a
// permanent change to standing service authorization. Unknown account fields
// remain significant by default; only explicitly operational fields are omitted.
func continuousAuthorityFingerprint(compares []store.RecordCompare, policies map[string]service.EffectivePolicy) (string, error) {
	normalized := make([]store.RecordCompare, 0, len(compares))
	for _, c := range compares {
		if (c.Kind == "accounts" || c.Kind == "users") && c.Expected != nil {
			raw, err := json.Marshal(c.Expected)
			if err != nil {
				return "", err
			}
			var account map[string]any
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if err = decoder.Decode(&account); err != nil {
				return "", err
			}
			fields := []string{"name", "usedBytes"}
			if c.Kind == "accounts" {
				fields = []string{"name", "username", "passwordHash", "totpSecret", "pendingTotpSecret", "pendingTotpExpires", "lastTotpStep"}
			}
			for _, field := range fields {
				delete(account, field)
			}
			c.Expected = account
		}
		normalized = append(normalized, c)
	}
	return fleet.Fingerprint(struct {
		Records  []store.RecordCompare
		Policies map[string]service.EffectivePolicy
	}{normalized, policies}), nil
}

func serviceLeaseExpiry(p preparedFleet, target string, expires, now time.Time) time.Time {
	for _, program := range p.Deployment.IR.Programs {
		if program.Instance.ID == target {
			for _, principal := range program.Principals {
				policy, ok := p.Policies[principal.AccountID]
				if !ok {
					continue
				}
				if end := policy.Entitlement.ExpiresAt; end != nil && end.Before(expires) {
					expires = *end
				}
				if window, e := policy.Entitlement.Cycle.Window(now); e == nil && window.NextReset != nil && window.NextReset.Before(expires) {
					expires = *window.NextReset
				}
			}
		}
	}
	return expires
}

// servicePolicyFence scopes the writer policy checks to every principal of the
// target instance. Missing snapshots deliberately produce an invalid check.
func servicePolicyFence(p preparedFleet, target string, deadline time.Time) store.ServicePolicyFence {
	f := store.ServicePolicyFence{ValidUntil: deadline}
	routes := map[string]map[string]bool{}
	for _, program := range p.Deployment.IR.Programs {
		if program.Instance.ID != target {
			continue
		}
		for _, principal := range program.Principals {
			if routes[principal.AccountID] == nil {
				routes[principal.AccountID] = map[string]bool{}
			}
			routes[principal.AccountID][principal.RouteID] = true
		}
	}
	ids := make([]string, 0, len(routes))
	for id := range routes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		check := store.ServicePolicyCheck{Policy: p.Policies[id]}
		for route := range routes[id] {
			check.RouteIDs = append(check.RouteIDs, route)
		}
		sort.Strings(check.RouteIDs)
		f.Checks = append(f.Checks, check)
	}
	return f
}
