package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"reflect"
	"regexp"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"time"
)

type ServerDeployment struct {
	ID          string                    `json:"id"`
	Name        string                    `json:"name"`
	IR          domain.ServerDeploymentIR `json:"ir"`
	Status      string                    `json:"status"`
	Diagnostics []string                  `json:"diagnostics"`
	UpdatedAt   time.Time                 `json:"updatedAt"`
}

func (h *server) registerServerAdmin(r chi.Router) {
	for _, kind := range []string{"hosts", "core-instances", "managed-endpoints", "links"} {
		kind := kind
		if kind == "managed-endpoints" {
			h.registerSecretInventoryRead(r, kind)
		} else {
			r.Get("/"+kind, func(w http.ResponseWriter, r *http.Request) { h.listGlobal(w, kind) })
		}
		save := func(w http.ResponseWriter, r *http.Request) { h.saveInventory(w, r, kind) }
		r.Post("/"+kind, save)
		r.Put("/"+kind+"/{id}", save)
	}
	r.Post("/managed-endpoints/{id}/impact", h.previewEndpointImpact)
	h.registerSecretInventoryRead(r, "server-deployments")
	save := func(w http.ResponseWriter, r *http.Request) {
		var v ServerDeployment
		if !decode(w, r, &v) {
			return
		}
		if e := ensureID(&v.ID); e != nil {
			storeError(w, e)
			return
		}
		if !pathMatches(r, v.ID) || v.Name == "" {
			fail(w, 400, "id and name required")
			return
		}
		expected, err := h.expectedRecord(r, "server-deployments", v.ID)
		if err != nil {
			storeError(w, err)
			return
		}
		v.IR.ID = v.ID
		if v.IR.SchemaVersion == "" {
			v.IR.SchemaVersion = "1.0"
		}
		v.Status = "draft"
		v.Diagnostics = []string{}
		if _, e := render.DefaultServers().Render(v.IR); e != nil {
			v.Diagnostics = append(v.Diagnostics, e.Error())
		}
		v.UpdatedAt = time.Now().UTC()
		if e := h.s.CompareAndPutRecords([]store.RecordCompare{*expected}, []store.RecordWrite{{Kind: "server-deployments", ID: v.ID, Value: v}}); e != nil {
			storeError(w, e)
			return
		}
		raw, _ := json.Marshal(v)
		writeJSON(w, 200, h.revisionView("server-deployments", v.ID, raw, false))
	}
	r.Post("/server-deployments", save)
	r.Put("/server-deployments/{id}", save)
	r.Post("/server-deployments/{id}/validate", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var raw json.RawMessage
		if e := h.s.Get("server-deployments", id, &raw); e != nil {
			storeError(w, e)
			return
		}
		// Review exactly the record the operator opened, including secret-only
		// changes. Never attach a newer fingerprint to an older visible draft.
		if !sameReviewToken(r.Header.Get("If-Match"), h.recordRevision("server-deployments", id, raw)) {
			writeServerDraftChanged(w)
			return
		}
		var v ServerDeployment
		if e := json.Unmarshal(raw, &v); e != nil {
			storeError(w, e)
			return
		}
		if e := h.verifyServerInventory(v.IR); e != nil {
			writeServerInventoryError(w, e)
			return
		}
		artifacts, e := render.DefaultServers().Render(v.IR)
		if e != nil {
			writeJSON(w, 200, map[string]any{"valid": false, "nativeChecked": false, "diagnostics": []string{e.Error()}, "artifacts": []domain.Artifact{}})
			return
		}
		for i := range artifacts {
			artifacts[i].Content = redactArtifact(artifacts[i].Content)
		}
		writeJSON(w, 200, map[string]any{"valid": true, "nativeChecked": false, "diagnostics": []string{}, "artifacts": artifacts, "fingerprint": serverFingerprint(v.IR)})
	})
	r.Post("/server-deployments/{id}/publish", h.publishServer)
	r.Get("/server-deployments/{id}/publication-requests/{operationId}", h.lookupPublicationRequest)
}

func writeServerDraftChanged(w http.ResponseWriter) {
	writeJSON(w, 409, map[string]any{"code": "SERVER_DRAFT_CHANGED", "detail": "saved forwarding path changed or was not reviewed; reload the path and check it again before applying"})
}
func (h *server) saveInventory(w http.ResponseWriter, r *http.Request, kind string) {
	var value any
	var id string
	switch kind {
	case "hosts":
		var v domain.Host
		if !decode(w, r, &v) {
			return
		}
		if e := validateHostLabels(v); e != nil {
			fail(w, 400, e.Error())
			return
		}
		if v.Name == "" || v.Address == "" {
			fail(w, 400, "host name and address required")
			return
		}
		id = v.ID
		value = v
	case "core-instances":
		var v domain.CoreInstance
		if !decode(w, r, &v) {
			return
		}
		var host domain.Host
		if e := h.s.Get("hosts", v.HostID, &host); e != nil {
			fail(w, 400, "host does not exist")
			return
		}
		if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$`).MatchString(v.AdapterID) || v.Version == "" {
			fail(w, 400, "valid adapter identity and version required; publication checks registry capability")
			return
		}
		id = v.ID
		value = v
	case "managed-endpoints":
		var v domain.ManagedEndpoint
		if !decode(w, r, &v) {
			return
		}
		var instance domain.CoreInstance
		if e := h.s.Get("core-instances", v.InstanceID, &instance); e != nil {
			fail(w, 400, "core instance does not exist")
			return
		}
		if v.Name == "" {
			fail(w, 400, "endpoint name required")
			return
		}
		if e := domain.ValidateManagedEndpoint(v); e != nil {
			storeError(w, e)
			return
		}
		id = v.ID
		value = v
	case "links":
		var v domain.Link
		if !decode(w, r, &v) {
			return
		}
		if v.From == v.To {
			fail(w, 400, "link cannot loop to itself")
			return
		}
		for _, id := range []string{v.From, v.To} {
			var endpoint domain.ManagedEndpoint
			if e := h.s.Get("managed-endpoints", id, &endpoint); e != nil {
				fail(w, 400, "link endpoint missing")
				return
			}
		}
		id = v.ID
		value = v
	}
	if !domain.ValidID(id) || !pathMatches(r, id) {
		fail(w, 400, "valid stable id required")
		return
	}
	var saveErr error
	if kind == "managed-endpoints" {
		saveErr = h.saveReviewedEndpoint(r, value.(domain.ManagedEndpoint))
	} else {
		saveErr = h.s.Put(kind, id, value)
	}
	if e := saveErr; e != nil {
		if kind == "managed-endpoints" && r.Method == http.MethodPut && errors.Is(e, store.ErrConflict) {
			fail(w, http.StatusConflict, "端点或引用已变化，请重新检查影响后再保存。当前输入仍保留。")
			return
		}
		storeError(w, e)
		return
	}
	h.s.Audit(current(r).Account.ID, "inventory.saved", kind+"/"+id)
	if kind == "managed-endpoints" {
		raw, _ := json.Marshal(value)
		value = h.revisionView(kind, id, raw, false)
	}
	writeJSON(w, 200, value)
}

// A scoped recovery identity is emitted only by the existing administrator routes.
// Never attach inventory records or underlying store errors to this response.
type serverInventoryMismatch struct{ kind, id string }

func (e *serverInventoryMismatch) Error() string {
	if e.kind == "instance" {
		return "program instance must match registered inventory"
	}
	return "program listener must match registered endpoint inventory"
}
func writeServerInventoryError(w http.ResponseWriter, err error) {
	var mismatch *serverInventoryMismatch
	if !errors.As(err, &mismatch) {
		fail(w, 422, "server inventory does not match saved intent")
		return
	}
	body := map[string]any{"detail": mismatch.Error(), "code": "SERVER_INVENTORY_MISMATCH"}
	if domain.ValidID(mismatch.id) {
		switch mismatch.kind {
		case "instance":
			body["code"] = "SERVER_INSTANCE_CHANGED"
			body["instanceId"] = mismatch.id
		case "listener":
			body["code"] = "SERVER_LISTENER_CHANGED"
			body["endpointId"] = mismatch.id
		}
	}
	writeJSON(w, 422, body)
}

func (h *server) verifyServerInventory(ir domain.ServerDeploymentIR) error {
	for _, p := range ir.Programs {
		var instance domain.CoreInstance
		if e := h.s.Get("core-instances", p.Instance.ID, &instance); e != nil && e != store.ErrNotFound {
			return e
		} else if e == store.ErrNotFound || instance.ID != p.Instance.ID {
			return &serverInventoryMismatch{kind: "instance"}
		}
		if instance != p.Instance {
			return &serverInventoryMismatch{kind: "instance", id: instance.ID}
		}
		var listener domain.ManagedEndpoint
		if e := h.s.Get("managed-endpoints", p.Listener.ID, &listener); e != nil && e != store.ErrNotFound {
			return e
		} else if e == store.ErrNotFound || listener.ID != p.Listener.ID {
			return &serverInventoryMismatch{kind: "listener"}
		}
		if !reflect.DeepEqual(listener, p.Listener) {
			return &serverInventoryMismatch{kind: "listener", id: listener.ID}
		}
	}
	return nil
}
func (h *server) publishServer(w http.ResponseWriter, r *http.Request) {
	var wire struct {
		OperationID         string `json:"operationId"`
		LeaseSeconds        int    `json:"leaseSeconds"`
		AccessAllowed       *bool  `json:"accessAllowed"`
		QuotaCertain        *bool  `json:"quotaCertain"`
		ExpectedFingerprint string `json:"expectedFingerprint"`
	}
	if !decode(w, r, &wire) {
		return
	}
	if wire.AccessAllowed == nil || wire.QuotaCertain == nil {
		fail(w, 400, "explicit boolean acknowledgements are required")
		return
	}
	in := publicationInput{OperationID: wire.OperationID, publicationIntent: publicationIntent{LeaseSeconds: wire.LeaseSeconds, AccessAllowed: *wire.AccessAllowed, QuotaCertain: *wire.QuotaCertain, ExpectedFingerprint: wire.ExpectedFingerprint}}
	if !domain.ValidID(in.OperationID) || !domain.ValidID(chi.URLParam(r, "id")) || !validPublicationIntent(in.publicationIntent) {
		fail(w, 400, "bounded operation identity, checked fingerprint and explicit policy lease of 30–3600 seconds are required")
		return
	}
	a, err := h.newPublicationAttempt(r, in)
	if err != nil {
		writePublicationOperationalError(w, err)
		return
	}
	if h.replayPublication(w, a) {
		return
	}
	proof := preparedFleet{}
	var v ServerDeployment
	if e := h.fleetRead(&proof, "server-deployments", a.deploymentID, &v, false); e != nil {
		if e == store.ErrNotFound {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", "The saved deployment no longer exists; select a current deployment and review again.")
			return
		}
		writePublicationOperationalError(w, e)
		return
	}
	if in.ExpectedFingerprint == "" || in.ExpectedFingerprint != serverFingerprint(v.IR) {
		h.rejectPublication(w, a, "SERVER_DRAFT_CHANGED", "The saved forwarding path changed; reload the path and check it again before submitting.")
		return
	}
	if e := h.verifyServerInventory(v.IR); e != nil {
		var mismatch *serverInventoryMismatch
		if errors.As(e, &mismatch) {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", "The instance or listener inventory changed; reload and review the current deployment.")
		} else {
			writePublicationOperationalError(w, e)
		}
		return
	}
	if in.AccessAllowed {
		for _, program := range v.IR.Programs {
			if controlprotocol.CoreActivationWithdrawn(program.Instance.AdapterID, program.Instance.Version) {
				h.rejectPublication(w, a, "CORE_RELEASE_WITHDRAWN", "This core release was withdrawn; review an upgrade before granting access.")
				return
			}
		}
	}
	artifacts, e := render.DefaultServers().Render(v.IR)
	if e != nil {
		h.rejectPublication(w, a, "PUBLICATION_REJECTED", "The deployment cannot be rendered; correct its configuration and review again.")
		return
	}
	if e = h.verifyServerTLSArtifactsWithProof(v.IR, artifacts, &proof); e != nil {
		var refusal *publicationRefusal
		if errors.As(e, &refusal) {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", refusal.detail)
		} else {
			writePublicationOperationalError(w, e)
		}
		return
	}
	enrollments := map[string]Enrollment{}
	for _, p := range v.IR.Programs {
		var en Enrollment
		if e := h.fleetRead(&proof, "instance-enrollments", p.Instance.ID, &en, false); e != nil && e != store.ErrNotFound {
			writePublicationOperationalError(w, e)
			return
		} else if e == store.ErrNotFound || en.Revoked || !time.Now().Before(en.ExpiresAt) {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", "A target enrollment is missing, revoked or expired; restore scoped enrollment and review again.")
			return
		}
		enrollments[p.Instance.ID] = en
	}
	result := publicationResult{OperationID: a.operationID, DeploymentID: a.deploymentID, Status: "publication-accepted", Instances: []publicationInstance{}}
	proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "publication-receipts", ID: a.receiptID})
	ids := []string{}
	desireds := map[string]controlprotocol.Desired{}
	serviceIntents := map[string]serviceIntent{}
	manifests := map[string]domain.PublishedManifest{}
	ownershipProofs := map[string]instanceOwnership{}
	for _, p := range v.IR.Programs {
		writes, err := h.prepareInstanceOwnership(&proof, p.Instance.ID, v.ID, "configure")
		if err != nil {
			var ownership *ownershipConflict
			if errors.As(err, &ownership) {
				h.rejectPublication(w, a, "PUBLICATION_REJECTED", "A target is owned by another deployment or has a conflicting operation; review target ownership before submitting.")
			} else {
				writePublicationOperationalError(w, err)
			}
			return
		}
		ownershipProofs[p.Instance.ID] = writes
		proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "core-instances", ID: p.Instance.ID, Expected: p.Instance}, store.RecordCompare{Kind: "managed-endpoints", ID: p.Listener.ID, Expected: p.Listener})
	}
	for _, p := range v.IR.Programs {
		parts := []domain.Artifact{}
		for _, artifact := range artifacts {
			prefix := p.Instance.ID + "/"
			if strings.HasPrefix(artifact.Path, prefix) {
				parts = append(parts, domain.Artifact{Path: strings.TrimPrefix(artifact.Path, prefix), Content: artifact.Content})
			}
		}
		digest, e := controlprotocol.ArtifactDigest(parts)
		if e != nil {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", "The artifact package is invalid; correct the deployment and review again.")
			return
		}
		revision, e := auth.Token()
		if e != nil {
			fail(w, 500, "cannot create revision")
			return
		}
		operation, e := auth.Token()
		if e != nil {
			fail(w, 500, "cannot create operation")
			return
		}
		now := time.Now().UTC()
		enrollment := enrollments[p.Instance.ID]
		desired := controlprotocol.Desired{Scope: enrollment.Scope, AdapterID: p.Instance.AdapterID, CoreVersion: p.Instance.Version, RevisionID: "rev_" + revision, OperationID: "op_" + operation, Digest: digest, EntryFile: "config.json", Artifacts: parts, Lease: controlprotocol.PolicyLease{Revision: v.IR.TopologyRevision, IssuedAt: now, ExpiresAt: now.Add(time.Duration(in.LeaseSeconds) * time.Second), AccessAllowed: in.AccessAllowed, QuotaCertain: in.QuotaCertain}}
		manifest, err := h.preparePublishedManifest(&proof, v, desired)
		if err != nil {
			var refusal *publicationRefusal
			var path *publishedPathRefusal
			if errors.As(err, &refusal) {
				h.rejectPublication(w, a, "PUBLICATION_REJECTED", refusal.detail)
			} else if errors.As(err, &path) {
				h.rejectPublication(w, a, "PUBLICATION_REJECTED", "A published route no longer matches the deployment; review the route and forwarding path.")
			} else {
				writePublicationOperationalError(w, err)
			}
			return
		}
		var previousService serviceIntent
		if e = h.fleetRead(&proof, "agent-service-intents", p.Instance.ID, &previousService, true); e != nil {
			writePublicationOperationalError(w, e)
			return
		}
		serviceIntents[p.Instance.ID] = previousService
		ids = append(ids, p.Instance.ID)
		desireds[p.Instance.ID] = desired
		manifests[p.Instance.ID] = manifest
		proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "published-manifests", ID: desired.RevisionID})
	}
	_, e = h.s.CompareSetsAndGenerateRecords("agent-desired", ids, proof.Compares, proof.Sets, func(generations map[string]uint64) ([]store.RecordWrite, error) {
		writes := []store.RecordWrite{}
		for _, id := range ids {
			ownership, err := ownershipProofs[id].queueWrites(id, "configure", generations[id])
			if err != nil {
				return nil, err
			}
			writes = append(writes, ownership...)
			desired := desireds[id]
			desired.Generation = generations[id]
			if previousService := serviceIntents[id]; previousService.ID != "" {
				previousService.Running = false
				previousService.Status = "disabled"
				previousService.Current = desired.Identity()
				previousService.PendingRefresh = nil
				writes = append(writes, store.RecordWrite{Kind: "agent-service-intents", ID: id, Value: previousService})
			}
			manifest := manifests[id]
			manifest.Identity.Generation = generations[id]
			result.Instances = append(result.Instances, publicationInstance{InstanceID: id, Generation: fmt.Sprintf("%d", generations[id]), OperationID: desired.OperationID, RevisionID: desired.RevisionID})
			writes = append(writes, store.RecordWrite{Kind: "agent-desired", ID: id, Value: desired}, store.RecordWrite{Kind: "published-manifests", ID: desired.RevisionID, Value: manifest})
		}
		writes = append(writes, store.RecordWrite{Kind: "publication-receipts", ID: a.receiptID, Value: a.receipt(result)})
		return writes, nil
	})
	if e != nil {
		if h.replayPublication(w, a) {
			return
		}
		var ownership *ownershipConflict
		if errors.As(e, &ownership) || errors.Is(e, store.ErrConflict) {
			h.rejectPublication(w, a, "PUBLICATION_REJECTED", "Publication inputs or target ownership changed; reload and review before submitting again.")
		} else {
			writePublicationOperationalError(w, e)
		}
		return
	}

	h.s.Audit(current(r).Account.ID, "deployment.queued", v.ID)
	writeJSON(w, 200, result)
}

var _ = json.Valid

func serverFingerprint(ir domain.ServerDeploymentIR) string {
	b, _ := json.Marshal(ir)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
