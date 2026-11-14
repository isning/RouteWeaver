package httpapi

import (
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"time"
)

// PublicEntryGrant is an explicitly provisioned user-facing connection. It is
// never inferred from a route's transit chain or a node's server credentials.
// Configuration records do not establish that a node has applied credentials.
type PublicEntryGrant struct {
	OutputID          string            `json:"outputId,omitempty"`
	OutputRevision    string            `json:"outputRevision,omitempty"`
	PublishedRouteID  string            `json:"publishedRouteId,omitempty"`
	SubjectID         string            `json:"subjectId,omitempty"`
	DeploymentID      string            `json:"deploymentId,omitempty"`
	Revoked           bool              `json:"revoked,omitempty"`
	ID                string            `json:"id"`
	UserID            string            `json:"userId"`
	RouteID           string            `json:"routeId"`
	Name              string            `json:"name"`
	CredentialVersion string            `json:"credentialVersion"`
	Connection        domain.Connection `json:"connection"`
}

func (h *server) registerEntryAdmin(r chi.Router) {
	r.Get("/users/{id}/entries", func(w http.ResponseWriter, r *http.Request) {
		raw, e := h.s.TenantList(chi.URLParam(r, "id"), "platform-entries")
		if e != nil {
			storeError(w, e)
			return
		}
		out := []map[string]any{}
		for _, b := range raw {
			var v PublicEntryGrant
			if e = json.Unmarshal(b, &v); e != nil {
				storeError(w, e)
				return
			}
			summary := entrySummary(v)
			if v.PublishedRouteID != "" && !v.Revoked {
				if _, err := h.effectivePublishedGrant(v); err == nil {
					summary["status"] = "effective"
				}
			}
			out = append(out, summary)
		}
		writeJSON(w, 200, out)
	})
	r.Get("/users/{id}/entries/{entryId}/reveal", func(w http.ResponseWriter, r *http.Request) {
		var v PublicEntryGrant
		if e := h.s.TenantGet(chi.URLParam(r, "id"), "platform-entries", chi.URLParam(r, "entryId"), &v); e != nil {
			storeError(w, e)
			return
		}
		if v.Revoked {
			fail(w, 404, "entry revoked")
			return
		}
		if v.PublishedRouteID != "" {
			connection, err := h.effectivePublishedGrant(v)
			if err != nil {
				fail(w, 409, err.Error())
				return
			}
			v.Connection = connection
		}
		w.Header().Set("Cache-Control", "no-store")
		if e := h.s.Audit(current(r).Account.ID, "entry.secret-revealed", v.UserID+"/"+v.ID); e != nil {
			fail(w, 503, "required audit unavailable")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Delete("/users/{id}/entries/{entryId}", func(w http.ResponseWriter, r *http.Request) {
		user, id := chi.URLParam(r, "id"), chi.URLParam(r, "entryId")
		e := h.s.UpdateRecords(store.TenantKind(user, "platform-entries"), id, func(raw json.RawMessage) ([]store.RecordWrite, error) {
			if len(raw) == 0 {
				return nil, store.ErrNotFound
			}
			var v PublicEntryGrant
			if e := json.Unmarshal(raw, &v); e != nil {
				return nil, e
			}
			v.Revoked = true
			audit := store.AuditEvent{ID: fmt.Sprintf("%d", time.Now().UnixNano()), ActorID: current(r).Account.ID, Action: "entry.revoked", TargetID: user + ":" + id, At: time.Now().UTC()}
			return []store.RecordWrite{{Kind: store.TenantKind(user, "platform-entries"), ID: id, Value: v}, {Kind: "audit", ID: audit.ID, Value: audit}}, nil
		})
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "status": "revoked"})
	})
	r.Post("/users/{id}/entries", func(w http.ResponseWriter, r *http.Request) {
		var v PublicEntryGrant
		if !decode(w, r, &v) {
			return
		}
		if v.PublishedRouteID != "" || v.SubjectID != "" || v.DeploymentID != "" || v.OutputID != "" || v.OutputRevision != "" {
			fail(w, 400, "managed grants must be provisioned through their published route")
			return
		}
		v.UserID = chi.URLParam(r, "id")
		if e := ensureID(&v.ID); e != nil {
			storeError(w, e)
			return
		}
		if v.Name == "" || !domain.ValidID(v.CredentialVersion) {
			fail(w, 400, "name and credential version required")
			return
		}
		if e := domain.ValidateConnection(v.Connection); e != nil {
			storeError(w, e)
			return
		}
		var published domain.PublishedRoute
		if e := h.s.Get("published-routes", v.RouteID, &published); e == nil {
			fail(w, 409, "published routes require their managed principal provisioning workflow")
			return
		} else if e != store.ErrNotFound {
			storeError(w, e)
			return
		}
		o, e := h.overview(v.UserID, time.Now())
		if e != nil {
			storeError(w, e)
			return
		}
		if o.Status != "active" {
			fail(w, 403, "account service is not active")
			return
		}
		authorized := false
		for _, entry := range o.Routes {
			authorized = authorized || entry.ID == v.RouteID
		}
		if !authorized {
			fail(w, 403, "route is not assigned to this user")
			return
		}
		v.Revoked = false
		kind := store.TenantKind(v.UserID, "platform-entries")
		var previousRaw json.RawMessage
		var expected any
		var previous PublicEntryGrant
		if e := h.s.Get(kind, v.ID, &previousRaw); e == nil {
			expected = previousRaw
			if e = json.Unmarshal(previousRaw, &previous); e != nil {
				storeError(w, e)
				return
			}
			if previous.PublishedRouteID != "" {
				fail(w, 409, "managed entry must be changed through its published route")
				return
			}
			if previous.CredentialVersion == v.CredentialVersion && (previous.Revoked || previous.RouteID != v.RouteID || connectionDigest(previous.Connection) != connectionDigest(v.Connection)) {
				fail(w, 409, "credential changes or reactivation require a new credential version")
				return
			}
		} else if e != store.ErrNotFound {
			storeError(w, e)
			return
		}
		compares := []store.RecordCompare{{Kind: kind, ID: v.ID, Expected: expected}}
		writes := []store.RecordWrite{{Kind: kind, ID: v.ID, Value: v}}
		versionsKind := store.TenantKind(v.UserID, "entry-versions")
		for _, grant := range []PublicEntryGrant{previous, v} {
			if grant.CredentialVersion == "" {
				continue
			}
			versionID := grant.ID + ":" + grant.CredentialVersion
			var marker string
			e := h.s.Get(versionsKind, versionID, &marker)
			if e == nil {
				if grant.CredentialVersion == v.CredentialVersion && previous.CredentialVersion != v.CredentialVersion {
					fail(w, 409, "credential version has already been retired")
					return
				}
				continue
			} else if e != store.ErrNotFound {
				storeError(w, e)
				return
			}
			compares = append(compares, store.RecordCompare{Kind: versionsKind, ID: versionID, Expected: nil})
			writes = append(writes, store.RecordWrite{Kind: versionsKind, ID: versionID, Value: connectionDigest(grant.Connection)})
		}
		if e := h.s.ComparePolicyAndPutRecords(o.EffectivePolicy, compares, writes); e != nil {
			storeError(w, e)
			return
		}
		h.s.Audit(current(r).Account.ID, "entry.granted", v.ID)
		writeJSON(w, 201, entrySummary(v))
	})
}
func (h *server) resolveEntry(owner, id string) (domain.ClientEndpoint, error) {
	return h.resolveEntryWithReader(owner, id, h.s)
}
func (h *server) resolveEntryWithReader(owner, id string, reader tenantRecordReader) (domain.ClientEndpoint, error) {
	var grant PublicEntryGrant
	if e := reader.TenantGet(owner, "platform-entries", id, &grant); e != nil {
		return domain.ClientEndpoint{}, fmt.Errorf("platform entry is missing or not owned")
	}
	if grant.OutputID != "" {
		if _, ok := reader.(attributedOutputReader); !ok {
			return domain.ClientEndpoint{}, fmt.Errorf("this credential is reserved for its independently metered subscription")
		}
	}
	overview, e := h.overview(owner, time.Now())
	if e != nil {
		return domain.ClientEndpoint{}, e
	}
	if grant.Revoked {
		return domain.ClientEndpoint{}, fmt.Errorf("platform entry is revoked")
	}
	if grant.PublishedRouteID == "" {
		var published domain.PublishedRoute
		if e := h.s.Get("published-routes", grant.RouteID, &published); e == nil {
			return domain.ClientEndpoint{}, fmt.Errorf("published route requires an applied managed principal")
		} else if e != store.ErrNotFound {
			return domain.ClientEndpoint{}, e
		}
	}
	if overview.Status != "active" {
		return domain.ClientEndpoint{}, fmt.Errorf("platform service access is inactive")
	}
	authorized := false
	for _, route := range overview.Routes {
		authorized = authorized || route.ID == grant.RouteID
	}
	if !authorized || grant.UserID != owner {
		return domain.ClientEndpoint{}, fmt.Errorf("platform route is not entitled")
	}
	if grant.PublishedRouteID != "" {
		connection, err := h.effectivePublishedGrant(grant)
		if err != nil {
			return domain.ClientEndpoint{}, err
		}
		grant.Connection = connection
	}
	return domain.ClientEndpoint{ID: grant.ID, Name: grant.Name, OwnerID: owner, Origin: "platform-entry", Connection: grant.Connection, Provenance: []domain.SourceRef{{SourceID: grant.RouteID, SnapshotID: grant.CredentialVersion, EndpointID: grant.ID}}}, nil
}

func entrySummary(v PublicEntryGrant) map[string]any {
	status := "configured-unverified"
	if v.PublishedRouteID != "" {
		status = "pending-deployment"
	}
	if v.Revoked {
		status = "revoked"
	}
	return map[string]any{"id": v.ID, "name": v.Name, "routeId": v.RouteID, "credentialVersion": v.CredentialVersion, "status": status, "revoked": v.Revoked, "publishedRouteId": v.PublishedRouteID, "subjectId": v.SubjectID, "deploymentId": v.DeploymentID}
}
