package httpapi

// Experimental integration branch only: this capability is inert until an
// administrator explicitly creates it. It never inherits service admin identity.
import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

type principalDelegation struct {
	ID                          string    `json:"id"`
	Revision                    string    `json:"revision"`
	Enabled                     bool      `json:"enabled"`
	IssuerAccountID             string    `json:"issuerAccountId"`
	IssuerAuthorityDigest       string    `json:"issuerAuthorityDigest,omitempty"`
	DeploymentID                string    `json:"deploymentId"`
	InstanceIDs                 []string  `json:"instanceIds"`
	AllowedRouteIDs             []string  `json:"allowedRouteIds"`
	MaxPrincipalsPerUser        int       `json:"maxPrincipalsPerUser"`
	MaxPendingIntents           int       `json:"maxPendingIntents"`
	AllowRuntimeRestart         bool      `json:"allowRuntimeRestart"`
	BaseNonPrincipalFingerprint string    `json:"baseNonPrincipalFingerprint"`
	ExpiresAt                   time.Time `json:"expiresAt"`
}

func principalIndependentFingerprint(ir domain.ServerDeploymentIR) string {
	raw, _ := json.Marshal(ir)
	var copy domain.ServerDeploymentIR
	_ = json.Unmarshal(raw, &copy)
	for i := range copy.Programs {
		copy.Programs[i].Principals = nil
	}
	return serverFingerprint(copy)
}
func deploymentInstanceIDs(ir domain.ServerDeploymentIR) []string {
	ids := make([]string, 0, len(ir.Programs))
	for _, p := range ir.Programs {
		ids = append(ids, p.Instance.ID)
	}
	sort.Strings(ids)
	return ids
}
func (h *server) validatePrincipalDelegation(proof *preparedFleet, capID, capRevision, owner, deploymentID string, now time.Time) error {
	var cap principalDelegation
	if err := h.fleetRead(proof, "principal-delegations", capID, &cap, false); err != nil {
		return err
	}
	if cap.ID != capID || cap.DeploymentID != deploymentID || cap.Revision != capRevision || !cap.Enabled || !cap.AllowRuntimeRestart || !now.Before(cap.ExpiresAt) {
		return fmt.Errorf("self-service principal authorization is unavailable")
	}
	// Revalidate the authorizing account, not the tenant's ability to impersonate it.
	if err := h.checkServiceAuthority(proof, serviceIntent{ActorID: cap.IssuerAccountID, AuthorityDigest: cap.IssuerAuthorityDigest}); err != nil {
		return err
	}
	var deployment ServerDeployment
	if err := h.fleetRead(proof, "server-deployments", deploymentID, &deployment, false); err != nil {
		return err
	}
	if cap.BaseNonPrincipalFingerprint != principalIndependentFingerprint(deployment.IR) || !reflect.DeepEqual(cap.InstanceIDs, deploymentInstanceIDs(deployment.IR)) {
		return fmt.Errorf("deployment topology changed after self-service authorization")
	}
	overview, err := h.overview(owner, now)
	if err != nil {
		return err
	}
	if overview.Status != "active" {
		return fmt.Errorf("account service is not active")
	}
	if proof.Policies == nil {
		proof.Policies = map[string]service.EffectivePolicy{}
	}
	proof.Policies[owner] = overview.EffectivePolicy
	return nil
}
func containsID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func (h *server) registerPrincipalDelegationAdmin(r chi.Router) {
	r.Get("/server-deployments/{id}/principal-delegation", func(w http.ResponseWriter, r *http.Request) {
		var cap principalDelegation
		if err := h.s.Get("principal-delegations", chi.URLParam(r, "id"), &cap); err == store.ErrNotFound {
			writeJSON(w, 200, map[string]any{"enabled": false, "revision": ""})
			return
		} else if err != nil {
			storeError(w, err)
			return
		}
		cap.IssuerAuthorityDigest = ""
		writeJSON(w, 200, cap)
	})
	r.Put("/server-deployments/{id}/principal-delegation", h.savePrincipalDelegation)
}
func (h *server) savePrincipalDelegation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ExpectedRevision     string    `json:"expectedRevision"`
		Enabled              bool      `json:"enabled"`
		AllowedRouteIDs      []string  `json:"allowedRouteIds"`
		MaxPrincipalsPerUser int       `json:"maxPrincipalsPerUser"`
		MaxPendingIntents    int       `json:"maxPendingIntents"`
		AllowRuntimeRestart  bool      `json:"allowRuntimeRestart"`
		ExpiresAt            time.Time `json:"expiresAt"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := chi.URLParam(r, "id")
	if !domain.ValidID(id) {
		fail(w, 400, "invalid deployment")
		return
	}
	var old principalDelegation
	var raw json.RawMessage
	err := h.s.Get("principal-delegations", id, &raw)
	var expected any
	if err == nil {
		if json.Unmarshal(raw, &old) != nil {
			fail(w, 503, "authorization unavailable")
			return
		}
		expected = raw
	} else if err != store.ErrNotFound {
		storeError(w, err)
		return
	}
	if old.Revision != in.ExpectedRevision {
		fail(w, 409, "authorization changed; reload it before saving")
		return
	}
	now := time.Now().UTC()
	proof := preparedFleet{}
	cap := old
	if in.Enabled {
		if !in.AllowRuntimeRestart || in.MaxPrincipalsPerUser < 1 || in.MaxPrincipalsPerUser > 64 || in.MaxPendingIntents < 1 || in.MaxPendingIntents > 4 || len(in.AllowedRouteIDs) < 1 || len(in.AllowedRouteIDs) > 16 || !in.ExpiresAt.After(now) || in.ExpiresAt.After(now.Add(30*24*time.Hour)) {
			fail(w, 400, "explicit restart permission, bounded limits, routes, and an expiry within 30 days are required")
			return
		}
		var deployment ServerDeployment
		if err := h.fleetRead(&proof, "server-deployments", id, &deployment, false); err != nil {
			storeError(w, err)
			return
		}
		seen := map[string]bool{}
		for _, routeID := range in.AllowedRouteIDs {
			if !domain.ValidID(routeID) || seen[routeID] {
				fail(w, 400, "routes must be unique")
				return
			}
			seen[routeID] = true
			var route domain.PublishedRoute
			if err := h.fleetRead(&proof, "published-routes", routeID, &route, false); err != nil {
				storeError(w, err)
				return
			}
			supported := false
			for _, p := range deployment.IR.Programs {
				if p.Listener.ID == route.Path.Entry && p.Instance.AdapterID == render.ServerAdapterManagedXray && p.Instance.Version == render.ManagedXrayVersion && p.Listener.Authentication == "principals" {
					supported = true
				}
			}
			if route.DeploymentID != id || !supported {
				fail(w, 422, "self-service requires an existing managed principal entry in this deployment")
				return
			}
			resolved, err := h.appliedPublishedPath(routeID)
			if err != nil || resolved.Fingerprint != serverFingerprint(deployment.IR) {
				fail(w, 409, "deployment must match its confirmed applied configuration")
				return
			}
		}
		sort.Strings(in.AllowedRouteIDs)
		cap = principalDelegation{ID: id, DeploymentID: id, Enabled: true, IssuerAccountID: current(r).Account.ID, InstanceIDs: deploymentInstanceIDs(deployment.IR), AllowedRouteIDs: in.AllowedRouteIDs, MaxPrincipalsPerUser: in.MaxPrincipalsPerUser, MaxPendingIntents: in.MaxPendingIntents, AllowRuntimeRestart: true, BaseNonPrincipalFingerprint: principalIndependentFingerprint(deployment.IR), ExpiresAt: in.ExpiresAt}
		if cap.IssuerAccountID == "operator" {
			cap.IssuerAuthorityDigest = auth.Digest(h.opts.AdminToken)
		}
		if err := h.checkServiceAuthority(&proof, serviceIntent{ActorID: cap.IssuerAccountID, AuthorityDigest: cap.IssuerAuthorityDigest}); err != nil {
			fail(w, 403, "administrator authorization required")
			return
		}
	} else {
		cap.ID = id
		cap.DeploymentID = id
		cap.Enabled = false
	}
	cap.Revision, err = auth.Token()
	if err != nil {
		storeError(w, err)
		return
	}
	proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "principal-delegations", ID: id, Expected: expected})
	audit := store.AuditEvent{ID: fmt.Sprintf("%d", now.UnixNano()), ActorID: current(r).Account.ID, Action: "principal-delegation.changed", TargetID: id, At: now}
	if err := h.s.CompareAndPutRecords(proof.Compares, []store.RecordWrite{{Kind: "principal-delegations", ID: id, Value: cap}, {Kind: "audit", ID: audit.ID, Value: audit}}); err != nil {
		storeError(w, err)
		return
	}
	cap.IssuerAuthorityDigest = ""
	writeJSON(w, 200, cap)
}
