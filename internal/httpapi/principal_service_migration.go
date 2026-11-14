package httpapi

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"time"
)

const maxPrincipalMigrationRecordBytes = 8 << 20

// Private receipts bind a tenant-requested, explicitly delegated delta to the
// pre-existing continuous-service authority. ActorID is never rewritten to make
// the requester an administrator. No HTTP route can submit these receipts.
type principalServiceMigration struct {
	ID                   string                              `json:"id"`
	Owner                string                              `json:"owner"`
	OutputID             string                              `json:"outputId"`
	OutputRevision       string                              `json:"outputRevision"`
	CapabilityRevision   string                              `json:"capabilityRevision"`
	DeploymentID         string                              `json:"deploymentId"`
	State                string                              `json:"state"`
	SourceMigrationID    string                              `json:"sourceMigrationId,omitempty"`
	CompensationID       string                              `json:"compensationId,omitempty"`
	CandidateFingerprint string                              `json:"candidateFingerprint"`
	CreatedAt            time.Time                           `json:"createdAt"`
	OldDeployment        ServerDeployment                    `json:"oldDeployment"`
	OldDesired           map[string]controlprotocol.Desired  `json:"oldDesired"`
	OldService           map[string]serviceIntent            `json:"oldService"`
	NewIdentities        map[string]controlprotocol.Identity `json:"newIdentities"`
}

type principalProvisioningLock struct {
	Owner          string `json:"owner"`
	OutputID       string `json:"outputId"`
	OutputRevision string `json:"outputRevision"`
	MigrationID    string `json:"migrationId"`
}

type preparedPrincipalMigration struct {
	Rate       *principalMigrationRatePlan
	Proof      preparedFleet
	Fence      store.ServicePolicyFence
	Receipt    principalServiceMigration
	TargetIDs  []string
	Batch      fleetRecord
	Writes     []store.RecordWrite
	Revisions  map[string]string
	Operations map[string]string
}

// This preparation has no side effects. Candidate grants and deployment are read
// through an overlay; original records and sets remain the final CAS inputs.
// The returned build must be committed with attribution and policy checks in ONE
// multi-generation transaction. Publishing any of Writes separately is invalid.
func (h *server) preparePrincipalServiceMigration(migrationID, owner, outputID, outputRevision, capRevision string, candidate ServerDeployment, writes []store.RecordWrite) (preparedPrincipalMigration, error) {
	return h.preparePrincipalServiceMutation(migrationID, owner, outputID, outputRevision, capRevision, candidate, writes, nil)
}

func (h *server) preparePrincipalServiceMutation(migrationID, owner, outputID, outputRevision, capRevision string, candidate ServerDeployment, writes []store.RecordWrite, removing *principalServiceMigration) (preparedPrincipalMigration, error) {
	out := preparedPrincipalMigration{}
	if !domain.ValidID(migrationID) || !domain.ValidID(owner) || !domain.ValidID(outputID) || !domain.ValidID(outputRevision) {
		return out, fmt.Errorf("invalid migration identity")
	}
	before := ServerDeployment{}
	proof := preparedFleet{Policies: map[string]service.EffectivePolicy{}}
	if err := h.fleetRead(&proof, "server-deployments", candidate.ID, &before, false); err != nil {
		return out, err
	}
	now := time.Now().UTC()
	var lock principalProvisioningLock
	var lockRaw json.RawMessage
	if err := h.fleetRead(&proof, "principal-provisioning-locks", candidate.ID, &lockRaw, true); err != nil {
		return out, err
	}
	lockPresent := len(lockRaw) > 0
	if lockPresent {
		if err := json.Unmarshal(lockRaw, &lock); err != nil {
			return out, err
		}
	}
	if removing == nil {
		if lockPresent {
			return out, fmt.Errorf("deployment has an unfinished subscription provisioning operation")
		}
	} else if lockPresent && (lock.Owner != owner || lock.OutputID != outputID || lock.OutputRevision != outputRevision || lock.MigrationID != removing.ID) {
		return out, fmt.Errorf("compensation provisioning lock changed")
	}
	var rate *principalMigrationRatePlan
	if removing == nil {
		plan, err := h.preparePrincipalMigrationRate(owner, candidate.ID, migrationID, now)
		if err != nil {
			return out, err
		}
		rate = &plan
	}
	var cap principalDelegation
	if removing == nil {
		if err := h.validatePrincipalDelegation(&proof, candidate.ID, capRevision, owner, candidate.ID, now); err != nil {
			return out, err
		}

		if err := h.fleetRead(&proof, "principal-delegations", candidate.ID, &cap, false); err != nil {
			return out, err
		}
		allowed := map[string]bool{}
		for _, id := range cap.AllowedRouteIDs {
			if proof.Policies[owner].AllowsRoute(id) {
				allowed[id] = true
			}
		}
		additions, err := validatePrincipalAddition(before.IR, candidate.IR, owner, allowed, cap.MaxPrincipalsPerUser)
		if err != nil {
			return out, err
		}
		_ = additions
		total := 0
		for _, program := range candidate.IR.Programs {
			for _, p := range program.Principals {
				if p.AccountID == owner {
					total++
				}
			}
		}
		if total > cap.MaxPrincipalsPerUser {
			return out, fmt.Errorf("principal limit exceeded")
		}
	} else {
		var source principalServiceMigration
		if err := h.fleetRead(&proof, "principal-service-migrations", removing.ID, &source, false); err != nil {
			return out, err
		}
		if source.Owner != owner || source.OutputID != outputID || source.OutputRevision != outputRevision || source.CompensationID != "" {
			return out, fmt.Errorf("compensation source changed")
		}
		expected, _, err := h.principalCompensationCandidate(&proof, source, before)
		if err != nil {
			return out, err
		}
		if serverFingerprint(expected.IR) != serverFingerprint(candidate.IR) {
			return out, fmt.Errorf("compensation changes more than its new principals")
		}
	}
	ids := deploymentInstanceIDs(before.IR)
	for _, write := range writes {
		allowedKind := write.Kind == store.TenantKind(owner, "platform-entries") || write.Kind == store.TenantKind(owner, "entry-versions") || write.Kind == "issued-principal-credentials" || write.Kind == "meter-bindings"
		if !allowedKind {
			return out, fmt.Errorf("record is outside delegated principal scope")
		}
		if removing != nil && write.Kind != store.TenantKind(owner, "platform-entries") {
			return out, fmt.Errorf("compensation may only revoke exact new grants")
		}
	}
	if removing == nil {
		for _, write := range writes {
			proof.Compares = append(proof.Compares, store.RecordCompare{Kind: write.Kind, ID: write.ID})
		}
	}
	encodedOverlay, encodeErr := json.Marshal(writes)
	if encodeErr != nil || len(encodedOverlay) > maxPrincipalMigrationRecordBytes {
		return out, fmt.Errorf("principal migration overlay exceeds 8 MiB")
	}
	overlay := append([]store.RecordWrite{}, writes...)
	overlay = append(overlay, store.RecordWrite{Kind: "server-deployments", ID: candidate.ID, Value: candidate})
	input := fleet.Input{ContinuousService: true, Action: "configure", DeploymentID: candidate.ID, TargetIDs: ids}
	next, err := h.prepareFleetWithOverlay(input, overlay)
	if err != nil {
		return out, err
	}
	if !next.Plan.Supported || serverFingerprint(next.Deployment.IR) != serverFingerprint(candidate.IR) {
		return out, fmt.Errorf("candidate principal grants are not currently eligible")
	}
	next.Compares = append(next.Compares, proof.Compares...)
	next.Sets = append(next.Sets, proof.Sets...)
	receipt := principalServiceMigration{ID: migrationID, Owner: owner, OutputID: outputID, OutputRevision: outputRevision, CapabilityRevision: capRevision, DeploymentID: candidate.ID, State: "queued", CandidateFingerprint: serverFingerprint(candidate.IR), CreatedAt: now, OldDeployment: before, OldDesired: map[string]controlprotocol.Desired{}, OldService: map[string]serviceIntent{}, NewIdentities: map[string]controlprotocol.Identity{}}
	deadline := now.Add(15 * time.Second)
	if removing == nil && cap.ExpiresAt.Before(deadline) {
		deadline = cap.ExpiresAt
	}
	revisions, operations := map[string]string{}, map[string]string{}
	leaseSeconds := 3600
	for _, id := range ids {
		desired := next.Baselines[id]
		if desired == nil {
			return out, fmt.Errorf("existing desired is absent")
		}
		var intent serviceIntent
		if err = h.fleetRead(&next, "agent-service-intents", id, &intent, false); err != nil {
			return out, err
		}
		if !intent.Running || intent.Current != desired.Identity() || intent.PendingRefresh != nil || (removing == nil && (intent.Status != "running" || !now.Before(intent.Lease.ExpiresAt))) {
			return out, fmt.Errorf("continuous service is not stable for migration")
		}
		if err = h.checkServiceAuthority(&next, intent); err != nil {
			return out, err
		}
		var oldBatch fleetRecord
		if err = h.fleetRead(&next, "fleet-batches", intent.BatchID, &oldBatch, false); err != nil {
			return out, err
		}
		if !oldBatch.Batch.ContinuousService || oldBatch.Deployment.ID != before.ID || serverFingerprint(oldBatch.Deployment.IR) != serverFingerprint(before.IR) {
			return out, fmt.Errorf("unpublished deployment changes exist")
		}
		baseline, err := h.prepareFleet(oldBatch.Batch.Input)
		if err != nil {
			return out, err
		}
		if baseline.ContinuousAuthorityHash != oldBatch.ContinuousAuthorityHash || serverFingerprint(baseline.Deployment.IR) != serverFingerprint(before.IR) {
			return out, fmt.Errorf("existing service authority changed")
		}
		next.Compares = append(next.Compares, baseline.Compares...)
		next.Sets = append(next.Sets, baseline.Sets...)
		var observation controlprotocol.State
		if err = h.fleetRead(&next, "agent-observations", id, &observation, false); err != nil {
			return out, err
		}
		observationAcceptable := observation.Phase == controlprotocol.ObservedConformant && observation.Observed != nil && observation.Observed.Identity == desired.Identity()
		if removing != nil && observation.Desired != nil && *observation.Desired == desired.Identity() && (observation.Phase == controlprotocol.ApplyFailed || observation.Phase == controlprotocol.ValidationFailed) && observation.Observed != nil {
			observationAcceptable = observation.Observed.Identity == desired.Identity() || observation.Observed.Identity == removing.OldDesired[id].Identity()
		}
		if !observationAcceptable || !observation.NativeChecked || observation.RecoveryRequired || observation.Observed == nil || !observation.Observed.Known || !observation.Observed.Quiescent || observation.Observed.ObservedAt.Before(now.Add(-15*time.Second)) || observation.Observed.ObservedAt.After(now.Add(5*time.Second)) {
			return out, fmt.Errorf("fresh exact applied evidence required")
		}
		if end := observation.Observed.ObservedAt.Add(15 * time.Second); end.Before(deadline) {
			deadline = end
		}
		if removing == nil && intent.Lease.ExpiresAt.Before(deadline) {
			deadline = intent.Lease.ExpiresAt
		}
		if next.Enrollments[id].ExpiresAt.Before(deadline) {
			deadline = next.Enrollments[id].ExpiresAt
		}
		if oldBatch.Batch.LeaseSeconds < leaseSeconds {
			leaseSeconds = oldBatch.Batch.LeaseSeconds
		}
		receipt.OldDesired[id] = *desired
		receipt.OldService[id] = intent
		token, e := auth.Token()
		if e != nil {
			return out, e
		}
		revisions[id] = "rev_" + token
		token, e = auth.Token()
		if e != nil {
			return out, e
		}
		operations[id] = "op_" + token
		next.Compares = append(next.Compares, store.RecordCompare{Kind: "published-manifests", ID: revisions[id]})
	}
	if leaseSeconds < 30 || !now.Before(deadline) {
		return out, fmt.Errorf("service migration authority expired")
	}
	next.Compares = append(next.Compares, store.RecordCompare{Kind: "principal-service-migrations", ID: migrationID}, store.RecordCompare{Kind: "fleet-batches", ID: migrationID})
	// Merge account policy checks across all targets without duplicate account IDs.
	checks := map[string]store.ServicePolicyCheck{}
	for _, id := range ids {
		for _, c := range servicePolicyFence(next, id, deadline).Checks {
			existing := checks[c.Policy.UserID]
			existing.Policy = c.Policy
			for _, r := range c.RouteIDs {
				if !containsID(existing.RouteIDs, r) {
					existing.RouteIDs = append(existing.RouteIDs, r)
				}
			}
			checks[c.Policy.UserID] = existing
		}
	}
	fence := store.ServicePolicyFence{ValidUntil: deadline}
	for _, c := range checks {
		fence.Checks = append(fence.Checks, c)
	}
	batch := fleetRecord{Batch: fleet.Batch{ID: migrationID, Plan: next.Plan, ActorID: owner, CreatedAt: now, LeaseSeconds: leaseSeconds, Status: "queued"}, Deployment: candidate, Baselines: map[string]*controlprotocol.Identity{}, Enrollments: next.Enrollments, AuthorizationHash: next.AuthorizationHash, ContinuousAuthorityHash: next.ContinuousAuthorityHash, Requests: map[string]string{"principal-migration": migrationID}}
	for _, id := range ids {
		identity := receipt.OldDesired[id].Identity()
		batch.Baselines[id] = &identity
	}
	if removing == nil {
		overlay = append(overlay, store.RecordWrite{Kind: "principal-provisioning-locks", ID: candidate.ID, Value: principalProvisioningLock{Owner: owner, OutputID: outputID, OutputRevision: outputRevision, MigrationID: migrationID}})
	}
	if removing != nil {
		receipt.SourceMigrationID = removing.ID
		if !lockPresent {
			overlay = append(overlay, store.RecordWrite{Kind: "principal-provisioning-locks", ID: candidate.ID, Value: principalProvisioningLock{Owner: owner, OutputID: outputID, OutputRevision: outputRevision, MigrationID: removing.ID}})
		}
		original := *removing
		original.State = "compensating"
		original.CompensationID = migrationID
		overlay = append(overlay, store.RecordWrite{Kind: "principal-service-migrations", ID: original.ID, Value: original})
	}
	out = preparedPrincipalMigration{Rate: rate, Proof: next, Fence: fence, Receipt: receipt, TargetIDs: ids, Batch: batch, Writes: overlay, Revisions: revisions, Operations: operations}
	return out, nil
}

func (p preparedPrincipalMigration) build(generations map[string]uint64) ([]store.RecordWrite, error) {
	now := time.Now().UTC()
	writes := append([]store.RecordWrite{}, p.Writes...)
	if p.Rate != nil {
		rateWrites, err := p.Rate.writes(p.Receipt.ID, now)
		if err != nil {
			return nil, err
		}
		writes = append(writes, rateWrites...)
	}
	receipt := p.Receipt
	receipt.NewIdentities = map[string]controlprotocol.Identity{}
	batch := p.Batch
	batch.Batch.Targets = append([]fleet.Target{}, p.Batch.Batch.Targets...)
	for _, program := range p.Proof.Deployment.IR.Programs {
		id := program.Instance.ID
		generation, ok := generations[id]
		if !ok {
			return nil, fmt.Errorf("missing migration generation")
		}
		parts := p.Proof.Artifacts[id]
		digest, err := controlprotocol.ArtifactDigest(parts)
		if err != nil {
			return nil, err
		}
		expires := serviceLeaseExpiry(p.Proof, id, now.Add(time.Duration(batch.Batch.LeaseSeconds)*time.Second), now)
		if p.Proof.Enrollments[id].ExpiresAt.Before(expires) {
			expires = p.Proof.Enrollments[id].ExpiresAt
		}
		if !now.Before(expires) {
			return nil, fmt.Errorf("migration lease expired")
		}
		desired := controlprotocol.Desired{Action: "configure", Scope: p.Proof.Enrollments[id].Scope, AdapterID: program.Instance.AdapterID, CoreVersion: program.Instance.Version, Generation: generation, RevisionID: p.Revisions[id], OperationID: p.Operations[id], Digest: digest, EntryFile: "config.json", Artifacts: parts, Lease: controlprotocol.PolicyLease{Revision: p.Proof.Deployment.IR.TopologyRevision, IssuedAt: now, ExpiresAt: expires, AccessAllowed: true, QuotaCertain: true}}
		identity := desired.Identity()
		receipt.NewIdentities[id] = identity
		old := receipt.OldService[id]
		next := old // retain the original service authority reference, never request identity
		next.BatchID = batch.Batch.ID
		next.Current = identity
		next.MigrationID = receipt.ID
		next.Lease = desired.Lease
		next.PendingRefresh = nil
		next.Status = "awaiting_observation"
		next.AutomaticAttempts = 0
		next.FailedGeneration = 0
		next.NextAttemptAt = time.Time{}
		next.ValidationNotBefore = time.Time{}
		ownership, err := p.Proof.OwnershipWrites[id].queueWrites(id, "configure", generation)
		if err != nil {
			return nil, err
		}
		writes = append(writes, ownership...)
		manifest := domain.PublishedManifest{DeploymentID: p.Proof.Deployment.ID, Fingerprint: serverFingerprint(p.Proof.Deployment.IR), Identity: domain.DeploymentIdentity{NodeID: identity.NodeID, InstanceID: id, EnrollmentEpoch: identity.EnrollmentEpoch, AdapterID: identity.AdapterID, CoreVersion: identity.CoreVersion, Generation: identity.Generation, RevisionID: identity.RevisionID, OperationID: identity.OperationID, Digest: identity.Digest}, Program: program, Routes: p.Proof.Routes, PolicyExpiresAt: expires}
		writes = append(writes, store.RecordWrite{Kind: "agent-desired", ID: id, Value: desired}, store.RecordWrite{Kind: "agent-service-intents", ID: id, Value: next}, store.RecordWrite{Kind: "published-manifests", ID: identity.RevisionID, Value: manifest})
		for i := range batch.Batch.Targets {
			if batch.Batch.Targets[i].InstanceID == id {
				batch.Batch.Targets[i].Status = "queued"
				batch.Batch.Targets[i].Attempts = []fleet.Attempt{{Number: 1, RequestID: receipt.ID, Identity: &identity, Status: "queued", QueuedAt: now, LeaseExpiresAt: expires}}
			}
		}
	}
	encodedReceipt, err := json.Marshal(receipt)
	if err != nil || len(encodedReceipt) > maxPrincipalMigrationRecordBytes {
		return nil, fmt.Errorf("principal migration receipt exceeds 8 MiB")
	}
	writes = append(writes, store.RecordWrite{Kind: "fleet-batches", ID: batch.Batch.ID, Value: batch}, store.RecordWrite{Kind: "principal-service-migrations", ID: receipt.ID, Value: receipt}, store.RecordWrite{Kind: "audit", ID: "principal-migration-" + receipt.ID, Value: store.AuditEvent{ID: "principal-migration-" + receipt.ID, ActorID: receipt.Owner, Action: "output.principal-migration.queued", TargetID: receipt.OutputID + "/" + receipt.ID, At: now}})
	return writes, nil
}

func (h *server) queuePrincipalServiceMigration(p preparedPrincipalMigration, bindings []store.EntryAdmissionBinding, compares []store.RecordCompare, writes []store.RecordWrite) error {
	p.Proof.Compares = append(p.Proof.Compares, compares...)
	if p.Rate != nil {
		p.Proof.Compares = append(p.Proof.Compares, p.Rate.Compares...)
	}
	_, err := h.s.CompareAttributedServicePolicyAndGenerateRecords(p.Fence, p.Proof.Policies[p.Receipt.Owner], p.Receipt.OutputID, p.Receipt.OutputRevision, "agent-desired", p.TargetIDs, bindings, p.Proof.Compares, p.Proof.Sets, func(g map[string]uint64) ([]store.RecordWrite, error) {
		built, e := p.build(g)
		return append(built, writes...), e
	})
	return err
}

func (h *server) reconcilePrincipalServiceMigration(owner, id string) (string, error) {
	var receipt principalServiceMigration
	if err := h.s.Get("principal-service-migrations", id, &receipt); err != nil {
		return "", err
	}
	if receipt.Owner != owner {
		return "", store.ErrNotFound
	}
	if receipt.State != "queued" {
		return receipt.State, nil
	}
	proof := preparedFleet{}
	if err := h.fleetRead(&proof, "principal-service-migrations", id, &receipt, false); err != nil {
		return "", err
	}
	now := time.Now().UTC()
	for instance, identity := range receipt.NewIdentities {
		var desired controlprotocol.Desired
		var observation controlprotocol.State
		if err := h.fleetRead(&proof, "agent-desired", instance, &desired, false); err != nil {
			return "", err
		}
		if desired.Identity() != identity {
			return "recovery_required", nil
		}
		if err := h.fleetRead(&proof, "agent-observations", instance, &observation, false); err != nil {
			return "queued", nil
		}
		if observation.RecoveryRequired {
			return "recovery_required", nil
		}
		if observation.Desired != nil && *observation.Desired == identity && (observation.Phase == controlprotocol.ApplyFailed || observation.Phase == controlprotocol.ValidationFailed) {
			return "compensation_required", nil
		}
		if observation.Phase != controlprotocol.ObservedConformant || !observation.NativeChecked || observation.Observed == nil || !observation.Observed.Known || !observation.Observed.Quiescent || observation.Observed.Identity != identity || observation.Observed.ObservedAt.Before(now.Add(-15*time.Second)) {
			return "queued", nil
		}
	}
	next := receipt
	next.State = "applied"
	writes := []store.RecordWrite{{Kind: "principal-service-migrations", ID: id, Value: next}}
	if receipt.SourceMigrationID != "" {
		var source principalServiceMigration
		if err := h.fleetRead(&proof, "principal-service-migrations", receipt.SourceMigrationID, &source, false); err != nil {
			return "", err
		}
		if source.CompensationID != id {
			return "recovery_required", nil
		}
		source.State = "compensated"
		writes = append(writes, store.RecordWrite{Kind: "principal-service-migrations", ID: source.ID, Value: source})
	}
	err := h.s.CompareAndPutRecords(proof.Compares, writes)
	return "applied", err
}
