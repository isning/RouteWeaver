package httpapi

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"reflect"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"time"
)

func (h *server) savePublishedPrincipal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AccountID         string                     `json:"accountId"`
		CredentialVersion string                     `json:"credentialVersion"`
		Credential        domain.PrincipalCredential `json:"credential"`
		EntryID           string                     `json:"entryId"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !domain.ValidID(in.AccountID) || !domain.ValidID(in.CredentialVersion) {
		fail(w, 400, "account and new credential version required")
		return
	}
	var route domain.PublishedRoute
	var routeRaw json.RawMessage
	if e := h.s.Get("published-routes", chi.URLParam(r, "id"), &routeRaw); e != nil {
		storeError(w, e)
		return
	}
	if e := json.Unmarshal(routeRaw, &route); e != nil {
		storeError(w, e)
		return
	}
	overview, e := h.overview(in.AccountID, time.Now())
	if e != nil {
		storeError(w, e)
		return
	}
	if overview.Status != "active" {
		fail(w, 403, "account service is not active")
		return
	}
	allowed := false
	for _, v := range overview.Routes {
		allowed = allowed || v.ID == route.ID
	}
	if !allowed {
		fail(w, 403, "published route is not assigned to this account")
		return
	}
	var deployment ServerDeployment
	var original json.RawMessage
	if e = h.s.Get("server-deployments", route.DeploymentID, &original); e != nil {
		storeError(w, e)
		return
	}
	if e = json.Unmarshal(original, &deployment); e != nil {
		storeError(w, e)
		return
	}
	var index = -1
	endpoints := []domain.ManagedEndpoint{}
	for _, id := range route.EndpointIDs {
		var endpoint domain.ManagedEndpoint
		if e = h.s.Get("managed-endpoints", id, &endpoint); e != nil {
			storeError(w, e)
			return
		}
		endpoints = append(endpoints, endpoint)
	}
	action, e := h.publishedPathAction(deployment.IR, route, endpoints)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	for i := range deployment.IR.Programs {
		if deployment.IR.Programs[i].Listener.ID == route.Path.Entry {
			index = i
		}
	}
	if index < 0 {
		fail(w, 422, "public entry program missing")
		return
	}
	program := &deployment.IR.Programs[index]
	if program.Instance.AdapterID != render.ServerAdapterManagedXray || program.Instance.Version != render.ManagedXrayVersion {
		fail(w, 422, "public account access requires a verified managed entry adapter")
		return
	}
	if e = ensureID(&in.EntryID); e != nil {
		storeError(w, e)
		return
	}
	kind := store.TenantKind(in.AccountID, "platform-entries")
	var previousRaw json.RawMessage
	var expected any
	var previous PublicEntryGrant
	if e = h.s.Get(kind, in.EntryID, &previousRaw); e == nil {
		expected = previousRaw
		if e = json.Unmarshal(previousRaw, &previous); e != nil {
			storeError(w, e)
			return
		}
		if previous.OutputID != "" {
			fail(w, 409, "independently metered credentials must be managed through their output lifecycle")
			return
		}
		if previous.PublishedRouteID == "" || previous.RouteID != route.ID {
			fail(w, 409, "entry identity belongs to a different route or authentication workflow")
			return
		}
		if previous.CredentialVersion == in.CredentialVersion {
			fail(w, 409, "credential replacement requires a new version")
			return
		}
	} else if e != store.ErrNotFound {
		storeError(w, e)
		return
	}
	versionKind := store.TenantKind(in.AccountID, "entry-versions")
	versionID := in.EntryID + ":" + in.CredentialVersion
	var marker string
	if e = h.s.Get(versionKind, versionID, &marker); e == nil {
		fail(w, 409, "credential version has already been used")
		return
	} else if e != store.ErrNotFound {
		storeError(w, e)
		return
	}
	if in.Credential.UUID == "" {
		b := make([]byte, 16)
		if _, e = rand.Read(b); e != nil {
			fail(w, 500, "cannot create credential")
			return
		}
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		in.Credential.UUID = fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
	}
	issuedCredentialID := program.Instance.ID + ":" + auth.Digest(strings.ToLower(in.Credential.UUID))
	var issuedSubject string
	if err := h.s.Get("issued-principal-credentials", issuedCredentialID, &issuedSubject); err == nil {
		fail(w, 409, "credential has already been used; generate a fresh credential instead of reviving it")
		return
	} else if err != store.ErrNotFound {
		storeError(w, err)
		return
	}
	token, e := auth.Token()
	if e != nil {
		storeError(w, e)
		return
	}
	principal := domain.ServerPrincipal{SubjectID: "sub_" + token, AccountID: in.AccountID, RouteID: route.ID, CredentialVersion: in.CredentialVersion, Credential: in.Credential, Action: action, PolicyRevision: deployment.IR.TopologyRevision, CycleID: "cycle_" + auth.Digest(overview.Cycle.Start.UTC().Format(time.RFC3339Nano))[:32]}
	if principal.CycleID == "" {
		principal.CycleID = "uncycled"
	}
	// Replacement removes only this previously bound principal, not another
	// account/route sharing the public listener.
	principals := []domain.ServerPrincipal{}
	for _, v := range program.Principals {
		if previous.SubjectID == "" || v.SubjectID != previous.SubjectID {
			principals = append(principals, v)
		}
	}
	program.Principals = append(principals, principal)
	endpoint := program.Listener
	var endpointRaw json.RawMessage
	if e = h.s.Get("managed-endpoints", endpoint.ID, &endpointRaw); e != nil {
		storeError(w, e)
		return
	}
	var inventoryEndpoint domain.ManagedEndpoint
	if e = json.Unmarshal(endpointRaw, &inventoryEndpoint); e != nil {
		storeError(w, e)
		return
	}
	if !reflect.DeepEqual(inventoryEndpoint, endpoint) {
		fail(w, 409, "listener inventory changed; refresh the deployment first")
		return
	}
	endpoint.Authentication = "principals"
	endpoint.Connection.UUID = ""
	endpoint.Connection.Flow = ""
	endpoint.Connection.Username = ""
	endpoint.Connection.Password = ""
	endpoint.Connection.Method = ""
	program.Listener = endpoint
	connection, e := domain.PublicPrincipalConnection(route, endpoint, principal)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	if _, e = render.DefaultServers().Render(deployment.IR); e != nil {
		fail(w, 422, e.Error())
		return
	}
	grant := PublicEntryGrant{ID: in.EntryID, UserID: in.AccountID, RouteID: route.ID, PublishedRouteID: route.ID, SubjectID: principal.SubjectID, DeploymentID: route.DeploymentID, Name: route.Name, CredentialVersion: in.CredentialVersion, Connection: connection}
	deployment.Status = "draft"
	deployment.UpdatedAt = time.Now().UTC()
	compares := []store.RecordCompare{{Kind: "published-routes", ID: route.ID, Expected: routeRaw}, {Kind: "managed-endpoints", ID: endpoint.ID, Expected: endpointRaw}, {Kind: "server-deployments", ID: deployment.ID, Expected: original}, {Kind: kind, ID: grant.ID, Expected: expected}, {Kind: versionKind, ID: versionID, Expected: nil}}
	writes := []store.RecordWrite{{Kind: "server-deployments", ID: deployment.ID, Value: deployment}, {Kind: "managed-endpoints", ID: endpoint.ID, Value: endpoint}, {Kind: kind, ID: grant.ID, Value: grant}, {Kind: versionKind, ID: versionID, Value: connectionDigest(connection)}}
	binding := store.EntryAdmissionBinding{ID: principal.SubjectID, InstanceID: program.Instance.ID, EntryID: endpoint.ID, SubjectID: principal.SubjectID, UserID: in.AccountID, RouteID: route.ID, GrantID: grant.ID, CredentialVersion: in.CredentialVersion}
	bindingRecord, err := store.EntryAdmissionBindingRecord(binding)
	if err != nil {
		storeError(w, err)
		return
	}
	rates, err := h.s.Rates()
	if err != nil {
		storeError(w, err)
		return
	}
	rateID := ""
	rateAt := time.Time{}
	now := time.Now().UTC()
	for _, rate := range rates {
		if rate.RouteID == route.ID && !rate.EffectiveAt.After(now) && rate.EffectiveAt.After(rateAt) {
			rateID = rate.ID
			rateAt = rate.EffectiveAt
		}
	}
	meter := store.MeterBinding{ID: principal.SubjectID, InstanceID: program.Instance.ID, SubjectID: principal.SubjectID, UserID: in.AccountID, RouteID: route.ID, PolicyRevision: principal.PolicyRevision, CycleID: principal.CycleID, MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget", RateID: rateID, EffectiveAt: now}
	meterRecord, err := store.MeterBindingRecord(meter)
	if err != nil {
		storeError(w, err)
		return
	}
	compares = append(compares, store.RecordCompare{Kind: "users", ID: overview.User.ID, Expected: overview.User}, store.RecordCompare{Kind: bindingRecord.Kind, ID: bindingRecord.ID, Expected: nil}, store.RecordCompare{Kind: meterRecord.Kind, ID: meterRecord.ID, Expected: nil})
	compares = append(compares, store.RecordCompare{Kind: "issued-principal-credentials", ID: issuedCredentialID, Expected: nil})
	writes = append(writes, store.RecordWrite{Kind: "issued-principal-credentials", ID: issuedCredentialID, Value: principal.SubjectID})
	writes = append(writes, bindingRecord, meterRecord)
	if e = h.s.ComparePolicyAndPutRecords(overview.EffectivePolicy, compares, writes); e != nil {
		storeError(w, e)
		return
	}
	h.s.Audit(current(r).Account.ID, "published-principal.saved", grant.ID)
	writeJSON(w, 201, map[string]any{"entryId": grant.ID, "subjectId": principal.SubjectID, "accountId": in.AccountID, "routeId": route.ID, "credentialVersion": in.CredentialVersion, "status": "pending-deployment"})
}
