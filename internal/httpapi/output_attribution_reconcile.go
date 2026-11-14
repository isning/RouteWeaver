package httpapi

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/store"
)

// One bounded, idempotent step. Restart recovery reads the encrypted intent and
// immutable migration receipt rather than guessing whether a prior write landed.
func (h *server) advanceAttributedOutput(owner, id string) (attributedOutputIntent, error) {
	var in attributedOutputIntent
	var raw json.RawMessage
	kind := store.TenantKind(owner, "output-attribution-intents")
	if err := h.s.Get(kind, id, &raw); err != nil {
		return in, err
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return in, err
	}
	if in.Owner != owner || in.ID != id {
		return in, store.ErrNotFound
	}
	if in.State == "published" || in.State == "cancelled" {
		return in, nil
	}
	if in.State == "cancelling" || in.State == "recovery_required" {
		return h.compensateAttributedOutput(in, raw)
	}
	if !time.Now().Before(in.Deadline) {
		return h.markAttributedOutputCancellation(in, raw, "provisioning_timeout")
	}
	deps := make([]string, 0, len(in.MigrationIDs))
	for dep := range in.MigrationIDs {
		deps = append(deps, dep)
	}
	sort.Strings(deps)
	for _, dep := range deps {
		migrationID := in.MigrationIDs[dep]
		var receipt principalServiceMigration
		err := h.s.Get("principal-service-migrations", migrationID, &receipt)
		if err == store.ErrNotFound {
			plan, err := h.prepareAttributedDeployment(in, dep, time.Now().UTC())
			if err != nil {
				return in, err
			}
			prepared, err := h.preparePrincipalServiceMigration(migrationID, owner, id, in.Revision, in.CapabilityRevisions[dep], plan.Deployment, plan.Writes)
			if err != nil {
				return in, err
			}
			next := in
			next.State = "provisioning"
			next.UpdatedAt = time.Now().UTC()
			compares := append(plan.Compares, store.RecordCompare{Kind: kind, ID: id, Expected: raw})
			if err := h.queuePrincipalServiceMigration(prepared, plan.Bindings, compares, []store.RecordWrite{{Kind: kind, ID: id, Value: next}}); err != nil {
				return in, err
			}
			return next, nil
		}
		if err != nil {
			return in, err
		}
		if receipt.Owner != owner || receipt.OutputID != id || receipt.OutputRevision != in.Revision {
			return in, fmt.Errorf("migration identity mismatch")
		}
		state, err := h.reconcilePrincipalServiceMigration(owner, migrationID)
		if err != nil {
			return in, err
		}
		if state == "compensation_required" || state == "recovery_required" {
			return h.markAttributedOutputCancellation(in, raw, state)
		}
		if state != "applied" {
			return in, nil
		}
	}
	return h.finishAttributedOutput(in, raw)
}
func (h *server) markAttributedOutputCancellation(in attributedOutputIntent, raw json.RawMessage, reason string) (attributedOutputIntent, error) {
	next := in
	next.State = "cancelling"
	next.FailureCode = reason
	next.UpdatedAt = time.Now().UTC()
	err := h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: store.TenantKind(in.Owner, "output-attribution-intents"), ID: in.ID, Expected: raw}}, []store.RecordWrite{{Kind: store.TenantKind(in.Owner, "output-attribution-intents"), ID: in.ID, Value: next}})
	return next, err
}
func (h *server) finishAttributedOutput(in attributedOutputIntent, raw json.RawMessage) (attributedOutputIntent, error) {
	proof := preparedFleet{}
	proof.Compares = append(proof.Compares, store.RecordCompare{Kind: store.TenantKind(in.Owner, "output-attribution-intents"), ID: in.ID, Expected: raw})
	now := time.Now().UTC()
	deadline := now.Add(15 * time.Second)
	if in.Deadline.Before(deadline) {
		deadline = in.Deadline
	}
	for dep, revision := range in.CapabilityRevisions {
		if err := h.validatePrincipalDelegation(&proof, dep, revision, in.Owner, dep, now); err != nil {
			return h.markAttributedOutputCancellation(in, raw, "authorization_changed")
		}
		var cap principalDelegation
		if err := h.fleetRead(&proof, "principal-delegations", dep, &cap, false); err != nil {
			return in, err
		}
		if cap.ExpiresAt.Before(deadline) {
			deadline = cap.ExpiresAt
		}
		for _, plan := range in.Plans {
			if plan.Grant.DeploymentID == dep && !containsID(cap.AllowedRouteIDs, plan.Grant.RouteID) {
				return h.markAttributedOutputCancellation(in, raw, "authorization_changed")
			}
		}
	}
	routes := []string{}
	for _, plan := range in.Plans {
		if !containsID(routes, plan.Grant.RouteID) {
			routes = append(routes, plan.Grant.RouteID)
		}
	}
	fence := store.ServicePolicyFence{ValidUntil: deadline, Checks: []store.ServicePolicyCheck{{Policy: proof.Policies[in.Owner], RouteIDs: routes}}}

	for _, migrationID := range in.MigrationIDs {
		var receipt principalServiceMigration
		if err := h.fleetRead(&proof, "principal-service-migrations", migrationID, &receipt, false); err != nil {
			return in, err
		}
		if receipt.State != "applied" || receipt.Owner != in.Owner || receipt.OutputID != in.ID || receipt.OutputRevision != in.Revision {
			return in, fmt.Errorf("applied output migration required")
		}
		for instance, identity := range receipt.NewIdentities {
			var desired controlprotocol.Desired
			var observed controlprotocol.State
			if err := h.fleetRead(&proof, "agent-desired", instance, &desired, false); err != nil {
				return in, err
			}
			if err := h.fleetRead(&proof, "agent-observations", instance, &observed, false); err != nil {
				return in, err
			}
			if desired.Identity() != identity || observed.RecoveryRequired || !observed.NativeChecked || observed.Phase != controlprotocol.ObservedConformant || observed.Observed == nil || observed.Observed.Identity != identity || !observed.Observed.Known || !observed.Observed.Quiescent {
				return in, fmt.Errorf("migration is no longer exactly applied")
			}
			var manifest json.RawMessage
			if err := h.fleetRead(&proof, "published-manifests", identity.RevisionID, &manifest, false); err != nil {
				return in, err
			}
		}
	}
	inputs := newTemplateInputs(h.s)
	prepared, err := h.prepareOutput(in.Owner, in.Output, inputs)
	if err != nil {
		return in, err
	}
	output := prepared.output
	if err := stampPublishedOutput(&output); err != nil {
		return in, err
	}
	output.Token, err = auth.Token()
	if err != nil {
		return in, err
	}
	output.TokenDigest = auth.Digest(output.Token)
	proof.Compares = append(proof.Compares, inputs.compares()...)
	proof.Sets = append(proof.Sets, inputs.sets...)
	if err := h.s.CompareInputsAndPublishAttributedOutput(fence, in.Owner, in.ID, in.Revision, output, output.TokenDigest, proof.Compares, proof.Sets); err != nil {
		return in, err
	}
	in.State = "published"
	return in, nil
}
