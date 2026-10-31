package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/store"
)

type fleetExecution struct {
	Stage     int      `json:"stage"`
	TargetIDs []string `json:"targetIds,omitempty"`
	RequestID string   `json:"requestId"`
}

func (h *server) executeFleet(retry bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in fleetExecution
		if !decode(w, r, &in) {
			return
		}
		if !retry && len(in.TargetIDs) > 0 {
			fail(w, 400, "execute selects an entire reviewed stage; targetIds is only for failed-target retries")
			return
		}
		if !domain.ValidID(in.RequestID) {
			fail(w, 400, "stable requestId required for idempotent execution")
			return
		}
		id := chi.URLParam(r, "id")
		var record fleetRecord
		if e := h.s.Get("fleet-batches", id, &record); e != nil {
			storeError(w, e)
			return
		}
		view, e := h.fleetView(record)
		if e != nil {
			storeError(w, e)
			return
		}
		targets := []string{}
		if retry {
			targets = in.TargetIDs
			if len(targets) == 0 {
				fail(w, 400, "explicit failed targets required")
				return
			}
		} else {
			for _, t := range view.Targets {
				if t.Stage == in.Stage {
					targets = append(targets, t.InstanceID)
				}
			}
		}
		signature := fleet.Fingerprint(struct {
			Retry bool
			Input fleetExecution
		}{retry, in})
		previous, exists := record.Requests[in.RequestID]
		if exists && previous != signature {
			fail(w, 409, "requestId is already bound to a different operation")
			return
		}
		if !exists {
			if len(record.Requests) >= 1000 {
				fail(w, 409, "batch attempt limit reached; create a new reviewed batch")
				return
			}
			if !retry {
				if e = fleet.CanExecuteStage(view.Targets, in.Stage); e != nil {
					fail(w, 409, e.Error())
					return
				}
			}
			if !retry {
				if e = h.fleetStageCurrent(record, in.Stage, &preparedFleet{}); e != nil {
					fail(w, 409, e.Error())
					return
				}
			}
			seen := map[string]bool{}
			for _, id := range targets {
				if seen[id] {
					fail(w, 400, "duplicate target")
					return
				}
				seen[id] = true
				var target *fleet.Target
				for n := range view.Targets {
					if view.Targets[n].InstanceID == id {
						target = &view.Targets[n]
					}
				}
				if target == nil || retry && target.Status != "failed" || !retry && target.Status != "planned" {
					fail(w, 409, "execute only planned targets; retry only known failed targets, never pending, uncertain or successful targets")
					return
				}
			}
			expected := record
			record.Requests = map[string]string{}
			for k, v := range expected.Requests {
				record.Requests[k] = v
			}
			record.Requests[in.RequestID] = signature
			if e = h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "fleet-batches", ID: id, Expected: expected}}, []store.RecordWrite{{Kind: "fleet-batches", ID: id, Value: record}}); e != nil {
				storeError(w, e)
				return
			}
		}
		for _, targetID := range targets {
			if e = h.queueFleetTarget(id, targetID, in.RequestID, current(r).Account.ID); e != nil {
				fail(w, 409, e.Error())
				return
			}
		}
		if e = h.s.Get("fleet-batches", id, &record); e != nil {
			storeError(w, e)
			return
		}
		view, e = h.fleetView(record)
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, view)
	}
}
func (h *server) queueFleetTarget(batchID, targetID, requestID, actor string) error {
	var record fleetRecord
	if e := h.s.Get("fleet-batches", batchID, &record); e != nil {
		return e
	}
	target, e := fleetTarget(&record, targetID)
	if e != nil {
		return e
	}
	for _, attempt := range target.Attempts {
		if attempt.RequestID == requestID {
			return nil
		}
	}
	// Refresh all current authority and render again. The saved plan remains the
	// reviewed input; credentials, enrollments, leases and usage are not revived.
	prepared, e := h.prepareFleet(record.Batch.Input)
	if e != nil {
		var conflict *ownershipConflict
		if errors.As(e, &conflict) {
			return e
		}
		return h.failFleetTarget(record, targetID, requestID, "review_required", actor)
	}
	if e = h.fleetStageCurrent(record, target.Stage, &prepared); e != nil {
		return h.failFleetTarget(record, targetID, requestID, "previous_stage_no_longer_current", actor)
	}
	if serverFingerprint(prepared.Deployment.IR) != serverFingerprint(record.Deployment.IR) || prepared.AuthorizationHash != record.AuthorizationHash {
		return h.failFleetTarget(record, targetID, requestID, "authorization_or_configuration_changed", actor)
	}
	if prepared.Enrollments[targetID] != record.Enrollments[targetID] || !time.Now().Before(prepared.Enrollments[targetID].ExpiresAt) || prepared.Enrollments[targetID].Revoked {
		return h.failFleetTarget(record, targetID, requestID, "enrollment_changed", actor)
	}
	var currentIdentity *controlprotocol.Identity
	if desired := prepared.Baselines[targetID]; desired != nil {
		value := desired.Identity()
		currentIdentity = &value
	}
	expectedIdentity := record.Baselines[targetID]
	for i := len(target.Attempts) - 1; i >= 0; i-- {
		if target.Attempts[i].Identity != nil {
			expectedIdentity = target.Attempts[i].Identity
			break
		}
	}
	if fleet.Fingerprint(currentIdentity) != fleet.Fingerprint(expectedIdentity) {
		return h.failFleetTarget(record, targetID, requestID, "desired_superseded_review_required", actor)
	}
	for _, t := range prepared.Plan.Targets {
		if t.InstanceID == targetID && !t.Supported {
			return h.failFleetTarget(record, targetID, requestID, "target_unsupported", actor)
		}
	}
	revision, e := auth.Token()
	if e != nil {
		return e
	}
	operation, e := auth.Token()
	if e != nil {
		return e
	}
	parts := prepared.Artifacts[targetID]
	digest, e := controlprotocol.ArtifactDigest(parts)
	if e != nil {
		return e
	}
	var program domain.ServerProgram
	for _, p := range prepared.Deployment.IR.Programs {
		if p.Instance.ID == targetID {
			program = p
		}
	}
	now := time.Now().UTC()
	expires := now.Add(time.Duration(record.Batch.LeaseSeconds) * time.Second)
	if prepared.Enrollments[targetID].ExpiresAt.Before(expires) {
		expires = prepared.Enrollments[targetID].ExpiresAt
	}
	revisionID, operationID := "rev_"+revision, "op_"+operation
	prepared.Compares = append(prepared.Compares, store.RecordCompare{Kind: "fleet-batches", ID: batchID, Expected: record}, store.RecordCompare{Kind: "published-manifests", ID: revisionID})
	_, e = h.s.CompareSetsAndGenerateRecord("agent-desired", targetID, prepared.Compares, prepared.Sets, func(g uint64) (any, []store.RecordWrite, error) {
		desired := controlprotocol.Desired{Action: record.Batch.Action, CoreReleaseID: record.Batch.TargetReleaseID, Scope: prepared.Enrollments[targetID].Scope, AdapterID: program.Instance.AdapterID, CoreVersion: program.Instance.Version, Generation: g, RevisionID: revisionID, OperationID: operationID, Digest: digest, EntryFile: "config.json", Artifacts: parts, Lease: controlprotocol.PolicyLease{Revision: record.Deployment.IR.TopologyRevision, IssuedAt: now, ExpiresAt: expires, AccessAllowed: record.Batch.Action != "stop", QuotaCertain: true}}
		if record.Batch.Action == "stop" {
			if old := prepared.Baselines[targetID]; old != nil {
				desired.EntryFile = old.EntryFile
			}
		}
		if record.Batch.Action == "upgrade" {
			transition, ok := record.Transitions[targetID]
			if !ok || prepared.Transitions[targetID] != transition {
				return nil, nil, fmt.Errorf("observed runtime changed; review upgrade again")
			}
			desired.Transition = &transition
		}
		identity := desired.Identity()
		target.Attempts = append(target.Attempts, fleet.Attempt{CoreReleaseID: record.Batch.TargetReleaseID, Number: len(target.Attempts) + 1, RequestID: requestID, Identity: &identity, Status: "queued", QueuedAt: now, LeaseExpiresAt: expires})
		target.Status = "queued"
		manifest := domain.PublishedManifest{DeploymentID: prepared.Deployment.ID, Fingerprint: serverFingerprint(prepared.Deployment.IR), Identity: domain.DeploymentIdentity{NodeID: identity.NodeID, InstanceID: identity.InstanceID, EnrollmentEpoch: identity.EnrollmentEpoch, AdapterID: identity.AdapterID, CoreVersion: identity.CoreVersion, Generation: identity.Generation, RevisionID: identity.RevisionID, OperationID: identity.OperationID, Digest: identity.Digest}, Program: program, Routes: prepared.Routes, PolicyExpiresAt: expires}
		audit := store.AuditEvent{ID: operationID, ActorID: actor, Action: "fleet." + record.Batch.Action + ".queued", TargetID: batchID + "/" + targetID, At: now}
		writes, err := prepared.OwnershipWrites[targetID].queueWrites(targetID, record.Batch.Action, g)
		if err != nil {
			return nil, nil, err
		}
		writes = append(writes, []store.RecordWrite{{Kind: "fleet-batches", ID: batchID, Value: record}, {Kind: "audit", ID: audit.ID, Value: audit}}...)
		if record.Batch.Action != "install" && record.Batch.Action != "stop" {
			writes = append(writes, store.RecordWrite{Kind: "published-manifests", ID: revisionID, Value: manifest})
		}
		if record.Batch.Action == "upgrade" {
			live := prepared.LiveDeployment
			for i := range live.IR.Programs {
				if live.IR.Programs[i].Instance.ID == targetID {
					live.IR.Programs[i].Instance = program.Instance
				}
			}
			live.UpdatedAt = now
			writes = append(writes, store.RecordWrite{Kind: "core-instances", ID: targetID, Value: program.Instance}, store.RecordWrite{Kind: "server-deployments", ID: live.ID, Value: live})
		}
		return desired, writes, nil
	})
	return e
}
func (h *server) failFleetTarget(record fleetRecord, targetID, requestID, code, actor string) error {
	original, _ := json.Marshal(record)
	target, e := fleetTarget(&record, targetID)
	if e != nil {
		return e
	}
	now := time.Now().UTC()
	target.Attempts = append(target.Attempts, fleet.Attempt{Number: len(target.Attempts) + 1, RequestID: requestID, Status: "failed", Code: code, Detail: fleetFailureDetail(code), QueuedAt: now})
	target.Status = "failed"
	auditID := fmt.Sprintf("fleet-failure-%d", now.UnixNano())
	audit := store.AuditEvent{ID: auditID, ActorID: actor, Action: "fleet.target.failed", TargetID: record.Batch.ID + "/" + targetID, At: now}
	return h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "fleet-batches", ID: record.Batch.ID, Expected: json.RawMessage(original)}}, []store.RecordWrite{{Kind: "fleet-batches", ID: record.Batch.ID, Value: record}, {Kind: "audit", ID: audit.ID, Value: audit}})
}

func fleetFailureDetail(code string) string {
	switch code {
	case "review_required":
		return "The current draft no longer validates. The reviewed input was retained; preview a new batch before applying it."
	case "authorization_or_configuration_changed":
		return "Configuration, credentials or account permissions changed after review. Preview a new batch; no new desired state was queued."
	case "enrollment_changed":
		return "This target's scoped enrollment changed, expired or was revoked. Review its enrollment before planning again."
	case "desired_superseded_review_required":
		return "A newer operation owns this target. Review the current desired state instead of overwriting it with this plan."
	case "previous_stage_no_longer_current":
		return "An earlier stage is no longer currently observed successful. Reconcile that agent before continuing."
	case "target_unsupported":
		return "The target cannot safely perform the reviewed action. Review its capabilities and current version."
	default:
		return "The target was not queued. Review its current state before retrying."
	}
}
