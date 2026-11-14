package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

type attributedPrincipalPlan struct {
	OriginalGrantID string                 `json:"originalGrantId"`
	Grant           PublicEntryGrant       `json:"grant"`
	Principal       domain.ServerPrincipal `json:"principal"`
	InstanceID      string                 `json:"instanceId"`
	EntryID         string                 `json:"entryId"`
}
type attributedOutputIntent struct {
	ID                  string                    `json:"id"`
	Owner               string                    `json:"owner"`
	Revision            string                    `json:"revision"`
	State               string                    `json:"state"`
	Deadline            time.Time                 `json:"deadline"`
	CreatedAt           time.Time                 `json:"createdAt"`
	UpdatedAt           time.Time                 `json:"updatedAt"`
	RequestDigest       string                    `json:"requestDigest"`
	Output              Output                    `json:"output"`
	Plans               []attributedPrincipalPlan `json:"plans"`
	CapabilityRevisions map[string]string         `json:"capabilityRevisions"`
	MigrationIDs        map[string]string         `json:"migrationIds"`
	FailureCode         string                    `json:"failureCode,omitempty"`
}

func attributionIntentView(in attributedOutputIntent) map[string]any {
	if in.State == "cancelling" && in.FailureCode == "cleanup_requires_runtime_evidence" {
		in.State = "recovery_required"
	}
	if in.State == "published" || in.State == "cancelled" {
		in.FailureCode = ""
	}
	return map[string]any{"id": in.ID, "name": in.Output.Name, "profileId": in.Output.ProfileID, "state": in.State, "createdAt": in.CreatedAt, "updatedAt": in.UpdatedAt, "failureCode": in.FailureCode, "coverage": "managed-platform-routes"}
}

func (h *server) reserveAttributedOutput(w http.ResponseWriter, r *http.Request) {
	var in outputCreationRequest
	if !decode(w, r, &in) {
		return
	}
	if !domain.ValidID(in.ID) || in.Name == "" {
		fail(w, 400, "new independent output requires a stable ID and name")
		return
	}
	owner := current(r).Account.ID
	raw, _ := json.Marshal(in)
	digest := auth.Digest(string(raw))
	var previous attributedOutputIntent
	if err := h.s.TenantGet(owner, "output-attribution-intents", in.ID, &previous); err == nil {
		if previous.RequestDigest != digest {
			fail(w, 409, "output ID belongs to another request")
			return
		}
		writeJSON(w, 200, attributionIntentView(previous))
		return
	} else if err != store.ErrNotFound {
		storeError(w, err)
		return
	}
	intent, proof, err := h.prepareAttributedOutputReservation(owner, in, digest, time.Now().UTC())
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	routes := []string{}
	for _, plan := range intent.Plans {
		if !containsID(routes, plan.Grant.RouteID) {
			routes = append(routes, plan.Grant.RouteID)
		}
	}
	deadline := time.Now().UTC().Add(30 * time.Second)
	for _, compare := range proof.Compares {
		if compare.Kind == "principal-delegations" {
			raw, _ := json.Marshal(compare.Expected)
			var cap principalDelegation
			_ = json.Unmarshal(raw, &cap)
			if cap.ExpiresAt.Before(deadline) {
				deadline = cap.ExpiresAt
			}
		}
	}
	fence := store.ServicePolicyFence{ValidUntil: deadline, Checks: []store.ServicePolicyCheck{{Policy: proof.Policies[owner], RouteIDs: routes}}}
	if err = h.s.CompareServicePolicyAndPutRecords(fence, proof.Compares, proof.Sets, []store.RecordWrite{{Kind: store.TenantKind(owner, "output-attribution-intents"), ID: in.ID, Value: intent}, store.OutputAttributionQueueRecord(owner, in.ID)}); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 202, attributionIntentView(intent))
}
func (h *server) prepareAttributedOutputReservation(owner string, in outputCreationRequest, digest string, now time.Time) (attributedOutputIntent, preparedFleet, error) {
	result := attributedOutputIntent{}
	proof := preparedFleet{}
	inputs := newTemplateInputs(h.s)
	// Keep identity reservation fences out of the configuration review digest.
	// They still participate in the final atomic reservation transaction.
	reservationInputs := newTemplateInputs(h.s)
	if err := reservationInputs.expectRecord(owner, "outputs", in.ID); err != nil {
		return result, proof, err
	}
	if err := reservationInputs.expectRecord(owner, "output-attribution-intents", in.ID); err != nil {
		return result, proof, err
	}
	for _, c := range reservationInputs.compares() {
		if c.Expected != nil {
			return result, proof, fmt.Errorf("output ID already reserved")
		}
	}
	var profile Profile
	if err := inputs.TenantGet(owner, "profiles", in.ProfileID, &profile); err != nil {
		return result, proof, err
	}
	if len(profile.PlatformEntryIDs) < 1 || len(profile.PlatformEntryIDs) > 16 || len(profile.SourceIDs) > 0 || profile.CollectionID != "" {
		return result, proof, fmt.Errorf("independent metering supports 1–16 managed platform entries, not imported subscriptions")
	}
	if err := h.materializeProfileWithReader(owner, &profile, inputs); err != nil {
		return result, proof, err
	}
	for _, endpoint := range profile.IR.Endpoints {
		if endpoint.Origin != "platform-entry" {
			return result, proof, fmt.Errorf("independent metering cannot cover imported endpoints")
		}
	}
	// Reject unsupported target/mode or invalid profile references before any
	// shared runtime mutation. The old-credential render is discarded, never issued.
	preview, err := h.prepareOutput(owner, in.output(), inputs)
	if err != nil {
		return result, proof, err
	}
	if in.PreviewDigest != nil && (len(*in.PreviewDigest) != 64 || subtle.ConstantTimeCompare([]byte(*in.PreviewDigest), []byte(preview.digest)) != 1) {
		return result, proof, fmt.Errorf("subscription review is stale; preview the selected profile again")
	}

	overview, err := h.overview(owner, now)
	if err != nil {
		return result, proof, err
	}
	if overview.Status != "active" {
		return result, proof, fmt.Errorf("account service is inactive")
	}
	revision, err := auth.Token()
	if err != nil {
		return result, proof, err
	}
	result = attributedOutputIntent{ID: in.ID, Owner: owner, Revision: revision, State: "reserved", Deadline: now.Add(10 * time.Minute), CreatedAt: now, UpdatedAt: now, RequestDigest: digest, Output: in.output(), Plans: []attributedPrincipalPlan{}, CapabilityRevisions: map[string]string{}, MigrationIDs: map[string]string{}}
	result.Output.Attribution = &outputAttribution{Revision: revision, Grants: map[string]string{}}
	caps := map[string]principalDelegation{}
	for _, originalID := range profile.PlatformEntryIDs {
		var old PublicEntryGrant
		if err := inputs.TenantGet(owner, "platform-entries", originalID, &old); err != nil {
			return result, proof, err
		}
		if old.OutputID != "" || old.PublishedRouteID == "" || old.Revoked {
			return result, proof, fmt.Errorf("select an existing managed platform entry, not another subscription's credential")
		}
		var route domain.PublishedRoute
		if err := h.fleetRead(&proof, "published-routes", old.RouteID, &route, false); err != nil {
			return result, proof, err
		}
		var cap principalDelegation
		if err := h.fleetRead(&proof, "principal-delegations", route.DeploymentID, &cap, false); err != nil {
			return result, proof, fmt.Errorf("self-service independent credentials have not been enabled for this route")
		}
		if err := h.validatePrincipalDelegation(&proof, cap.ID, cap.Revision, owner, route.DeploymentID, now); err != nil {
			return result, proof, err
		}
		if !containsID(cap.AllowedRouteIDs, route.ID) || !overview.EffectivePolicy.AllowsRoute(route.ID) {
			return result, proof, fmt.Errorf("route is outside the authorized self-service scope")
		}
		caps[cap.ID] = cap
		if cap.ExpiresAt.Before(result.Deadline) {
			result.Deadline = cap.ExpiresAt
		}
		result.CapabilityRevisions[cap.ID] = cap.Revision
		result.MigrationIDs[cap.ID] = "om_" + auth.Digest(owner + "/" + in.ID + "/" + revision + "/" + cap.ID)[:32]
		var deployment ServerDeployment
		if err := h.fleetRead(&proof, "server-deployments", route.DeploymentID, &deployment, false); err != nil {
			return result, proof, err
		}
		manifest, err := h.appliedPublishedPath(route.ID)
		if err != nil || manifest.Fingerprint != serverFingerprint(deployment.IR) {
			return result, proof, fmt.Errorf("route must have a confirmed unchanged deployment before provisioning")
		}
		var program domain.ServerProgram
		found := false
		endpoints := []domain.ManagedEndpoint{}
		for _, id := range route.EndpointIDs {
			for _, p := range deployment.IR.Programs {
				if p.Listener.ID == id {
					endpoints = append(endpoints, p.Listener)
				}
				if p.Listener.ID == route.Path.Entry {
					program = p
					found = true
				}
			}
		}
		if !found {
			return result, proof, fmt.Errorf("managed entry missing")
		}
		action, err := h.publishedPathAction(deployment.IR, route, endpoints)
		if err != nil {
			return result, proof, err
		}
		b := make([]byte, 16)
		if _, err = rand.Read(b); err != nil {
			return result, proof, err
		}
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		uuid := fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
		subject, err := auth.Token()
		if err != nil {
			return result, proof, err
		}
		principal := domain.ServerPrincipal{SubjectID: "sub_" + subject, AccountID: owner, RouteID: route.ID, CredentialVersion: "out_" + revision, Credential: domain.PrincipalCredential{UUID: uuid}, Action: action, PolicyRevision: deployment.IR.TopologyRevision, CycleID: "cycle_" + auth.Digest(overview.Cycle.Start.UTC().Format(time.RFC3339Nano))[:32]}
		connection, err := domain.PublicPrincipalConnection(route, program.Listener, principal)
		if err != nil {
			return result, proof, err
		}
		grantID := "og_" + auth.Digest(owner + "/" + in.ID + "/" + revision + "/" + originalID)[:32]
		grant := PublicEntryGrant{ID: grantID, UserID: owner, OutputID: in.ID, OutputRevision: revision, RouteID: route.ID, PublishedRouteID: route.ID, SubjectID: principal.SubjectID, DeploymentID: route.DeploymentID, Name: old.Name, CredentialVersion: principal.CredentialVersion, Connection: connection}
		result.Output.Attribution.Grants[originalID] = grantID
		result.Plans = append(result.Plans, attributedPrincipalPlan{OriginalGrantID: originalID, Grant: grant, Principal: principal, InstanceID: program.Instance.ID, EntryID: program.Listener.ID})
	}
	// Bound pending and eventual isolated principals under the same owner-set CAS.
	history, historySet, err := h.s.ListOutputAttributionIntents(owner)
	if err != nil {
		return result, proof, err
	}
	if len(history) >= store.OutputAttributionHistoryLimit {
		return result, proof, store.ErrAttributionCapacity
	}
	proof.Compares = append(proof.Compares, history...)
	proof.Sets = append(proof.Sets, historySet)
	pending := map[string]int{}
	principals := map[string]int{}
	existingSubjects := map[string]map[string]bool{}
	for dep := range caps {
		var current ServerDeployment
		if err := h.fleetRead(&proof, "server-deployments", dep, &current, false); err != nil {
			return result, proof, err
		}
		existingSubjects[dep] = map[string]bool{}
		for _, program := range current.IR.Programs {
			for _, principal := range program.Principals {
				if principal.AccountID == owner {
					existingSubjects[dep][principal.SubjectID] = true
					principals[dep]++
				}
			}
		}
	}

	for _, record := range history {
		raw := record.Expected.(json.RawMessage)
		var prior attributedOutputIntent
		if json.Unmarshal(raw, &prior) != nil {
			return result, proof, fmt.Errorf("invalid provisioning state")
		}
		if prior.State == "cancelled" {
			continue
		}
		deps := map[string]bool{}
		for _, p := range prior.Plans {
			if !existingSubjects[p.Grant.DeploymentID][p.Principal.SubjectID] {
				principals[p.Grant.DeploymentID]++
			}
			deps[p.Grant.DeploymentID] = true
		}
		if prior.State != "published" {
			for dep := range deps {
				pending[dep]++
			}
		}
	}
	for _, p := range result.Plans {
		principals[p.Grant.DeploymentID]++
	}
	for dep, cap := range caps {
		if pending[dep] >= cap.MaxPendingIntents || principals[dep] > cap.MaxPrincipalsPerUser {
			return result, proof, fmt.Errorf("independent subscription provisioning limit reached")
		}
	}
	// The reservation caller must consume both record and set fences atomically.
	proof.Compares = append(proof.Compares, inputs.compares()...)
	proof.Compares = append(proof.Compares, reservationInputs.compares()...)
	sort.Slice(result.Plans, func(i, j int) bool { return result.Plans[i].OriginalGrantID < result.Plans[j].OriginalGrantID })
	return result, proof, nil
}
