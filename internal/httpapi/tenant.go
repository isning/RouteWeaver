package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/auth"
	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
	"strings"
	"time"
)

type SourceApplyEvent struct {
	ID                string    `json:"id"`
	AppliedAt         time.Time `json:"appliedAt"`
	Mode              string    `json:"mode"`
	BeforeCount       int       `json:"beforeCount"`
	AfterCount        int       `json:"afterCount"`
	Added             int       `json:"added"`
	Removed           int       `json:"removed"`
	ConnectionChanged int       `json:"connectionChanged"`
	Renamed           int       `json:"renamed"`
	Reordered         bool      `json:"reordered"`
}

type Source struct {
	ApplyMode     string                 `json:"applyMode"`
	ApplyHistory  []SourceApplyEvent     `json:"applyHistory,omitempty"`
	Revision      string                 `json:"revision,omitempty"`
	Candidate     *SourceCandidate       `json:"candidate,omitempty"`
	CheckedAt     *time.Time             `json:"checkedAt,omitempty"`
	RefreshStatus string                 `json:"refreshStatus,omitempty"`
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	OwnerID       string                 `json:"ownerId,omitempty"`
	Kind          string                 `json:"kind"`
	Content       string                 `json:"content,omitempty"`
	URL           string                 `json:"url,omitempty"`
	Format        string                 `json:"format,omitempty"`
	Enabled       bool                   `json:"enabled"`
	AcceptPartial bool                   `json:"acceptPartial,omitempty"`
	Diagnostics   []importer.Diagnostic  `json:"diagnostics,omitempty"`
	Snapshot      *domain.SourceSnapshot `json:"snapshot,omitempty"`
	LastError     string                 `json:"lastError,omitempty"`
	LastErrorCode string                 `json:"lastErrorCode,omitempty"`
	UpdatedAt     time.Time              `json:"updatedAt"`
}
type Profile struct {
	PlatformEntryIDs []string               `json:"platformEntryIds,omitempty"`
	Status           string                 `json:"status"`
	Diagnostics      []string               `json:"diagnostics,omitempty"`
	ID               string                 `json:"id"`
	Name             string                 `json:"name"`
	Target           render.Target          `json:"target"`
	Mode             render.OutputMode      `json:"mode"`
	CollectionID     string                 `json:"collectionId,omitempty"`
	SourceIDs        []string               `json:"sourceIds,omitempty"`
	IR               domain.ClientProfileIR `json:"ir"`
	UpdatedAt        time.Time              `json:"updatedAt"`
}

func (h *server) registerTenant(r chi.Router) {
	r.Route("/me", func(r chi.Router) {
		r.Get("/overview", func(w http.ResponseWriter, r *http.Request) {
			v, e := h.overviewContext(r.Context(), current(r).Account.ID, time.Now())
			if e != nil {
				storeError(w, e)
				return
			}
			writeJSON(w, 200, v)
		})
		r.Get("/platform-entries", func(w http.ResponseWriter, r *http.Request) {
			all, e := h.s.TenantList(current(r).Account.ID, "platform-entries")
			if e != nil {
				fail(w, 500, "cannot list entries")
				return
			}
			out := []map[string]any{}
			for _, b := range all {
				var v PublicEntryGrant
				if json.Unmarshal(b, &v) != nil {
					continue
				}
				if _, e := h.resolveEntry(current(r).Account.ID, v.ID); e != nil {
					continue
				}
				out = append(out, map[string]any{"id": v.ID, "name": v.Name, "routeId": v.RouteID, "credentialVersion": v.CredentialVersion, "status": "configured-unverified"})
			}
			writeJSON(w, 200, out)
		})
		r.Get("/capabilities", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, render.DefaultClients().Capabilities())
		})
		for _, kind := range []string{"sources", "profiles"} {
			kind := kind
			r.Get("/"+kind+"/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
				var v json.RawMessage
				if e := h.s.TenantGet(current(r).Account.ID, kind, chi.URLParam(r, "id"), &v); e != nil {
					storeError(w, e)
					return
				}
				w.Header().Set("Cache-Control", "no-store")
				if e := h.s.Audit(current(r).Account.ID, "tenant.secret-revealed", kind+"/"+chi.URLParam(r, "id")); e != nil {
					fail(w, http.StatusServiceUnavailable, "required audit unavailable")
					return
				}
				if kind == "sources" {
					var source Source
					if json.Unmarshal(v, &source) != nil {
						fail(w, 500, "cannot read source")
						return
					}
					writeJSON(w, 200, sourceView(source, true))
				} else {
					writeJSON(w, 200, h.tenantRecordView(current(r).Account.ID, kind, v, true))
				}
			})
		}
		for _, kind := range []string{"sources", "collections", "profiles", "resources"} {
			kind := kind
			r.Get("/"+kind, func(w http.ResponseWriter, r *http.Request) { h.listTenant(w, r, kind) })
			r.Get("/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) {
				var v json.RawMessage
				if e := h.s.TenantGet(current(r).Account.ID, kind, chi.URLParam(r, "id"), &v); e != nil {
					storeError(w, e)
					return
				}
				writeJSON(w, 200, h.tenantRecordView(current(r).Account.ID, kind, v, false))
			})
			r.Delete("/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) {
				if e := h.deleteTenant(current(r).Account.ID, kind, chi.URLParam(r, "id")); e != nil {
					fail(w, 409, e.Error())
					return
				}
				writeJSON(w, 200, map[string]bool{"ok": true})
			})
		}
		r.Post("/sources", h.saveSource)
		r.Put("/sources/{id}", h.saveSource)
		r.Post("/sources/{id}/refresh", h.refreshSource)
		r.Post("/sources/{id}/apply", h.decideSourceCandidate)
		r.Get("/sources/{id}/candidate", h.sourceCandidate)
		r.Get("/sources/{id}/candidate/reveal", h.sourceCandidate)
		r.Post("/sources/{id}/candidate/accept", h.decideSourceCandidate)
		r.Post("/sources/{id}/candidate/reject", h.decideSourceCandidate)
		r.Get("/collections/{id}/dependencies", h.collectionDependencies)
		r.Post("/collections", h.saveCollection)
		r.Put("/collections/{id}", h.saveCollection)
		r.Post("/collections/preview", h.previewCollection)
		r.Post("/collections/{id}/preview", h.previewCollection)
		r.Post("/profiles", h.saveProfile)
		r.Put("/profiles/{id}", h.saveProfile)
		r.Post("/profiles/preview", h.previewProfile)
		r.Post("/profiles/{id}/preview", h.previewProfile)
		r.Post("/resources/inspect", h.inspectResource)
		r.Post("/resources/import", h.importRuleResource)
		r.Post("/resources/{id}/refresh", h.refreshRuleResource)
		r.Post("/resources", h.saveResource)
		r.Put("/resources/{id}", h.saveResource)
		h.registerOutputs(r)
	})
}
func (h *server) listTenant(w http.ResponseWriter, r *http.Request, kind string) {
	v, e := h.s.TenantList(current(r).Account.ID, kind)
	if e != nil {
		fail(w, 500, "cannot list private records")
		return
	}
	for i := range v {
		v[i] = h.tenantRecordView(current(r).Account.ID, kind, v[i], false)
	}
	writeJSON(w, 200, v)
}
func ensureID(id *string) error {
	if *id == "" {
		v, e := auth.Token()
		if e != nil {
			return e
		}
		*id = "r_" + v
	}
	if !domain.ValidID(*id) {
		return fmt.Errorf("invalid resource id")
	}
	return nil
}
func sameOwner(owner *string, expected string) error {
	if *owner != "" && *owner != expected {
		return fmt.Errorf("resource owner mismatch")
	}
	*owner = expected
	return nil
}
func pathMatches(r *http.Request, id string) bool {
	path := chi.URLParam(r, "id")
	return path == "" || path == id
}
func (h *server) resolveCollection(owner string, v domain.Collection) (conversion.CollectionResult, error) {
	return h.resolveCollectionWithReader(owner, v, h.s)
}
func (h *server) resolveCollectionWithReader(owner string, v domain.Collection, reader tenantRecordReader) (conversion.CollectionResult, error) {
	snaps := []domain.SourceSnapshot{}
	for _, ref := range v.Sources {
		var s Source
		if e := reader.TenantGet(owner, "sources", ref.SourceID, &s); e != nil {
			return conversion.CollectionResult{}, fmt.Errorf("source is missing or not owned")
		}
		if !s.Enabled || s.Snapshot == nil {
			return conversion.CollectionResult{}, fmt.Errorf("source has no enabled accepted snapshot")
		}
		snaps = append(snaps, *s.Snapshot)
	}
	return conversion.ProcessCollection(v, snaps)
}
func (h *server) collectionInput(w http.ResponseWriter, r *http.Request) (domain.Collection, bool) {
	owner := current(r).Account.ID
	var v domain.Collection
	if id := chi.URLParam(r, "id"); id != "" && strings.HasSuffix(r.URL.Path, "/preview") {
		if e := h.s.TenantGet(owner, "collections", id, &v); e != nil {
			storeError(w, e)
			return v, false
		}
	} else if !decode(w, r, &v) {
		return v, false
	}
	if e := ensureID(&v.ID); e != nil {
		storeError(w, e)
		return v, false
	}
	if e := sameOwner(&v.OwnerID, owner); e != nil {
		fail(w, 403, e.Error())
		return v, false
	}
	return v, true
}
func (h *server) saveCollection(w http.ResponseWriter, r *http.Request) {
	v, ok := h.collectionInput(w, r)
	if !ok {
		return
	}
	if !pathMatches(r, v.ID) {
		fail(w, 400, "id mismatch")
		return
	}
	inputs := newTemplateInputs(h.s)
	if e := inputs.expectRecord(v.OwnerID, "collections", v.ID); e != nil {
		storeError(w, e)
		return
	}
	if _, e := h.resolveCollectionWithReader(current(r).Account.ID, v, inputs); e != nil {
		storeError(w, e)
		return
	}
	if e := h.s.CompareAndPutRecords(inputs.compares(), []store.RecordWrite{{Kind: store.TenantKind(v.OwnerID, "collections"), ID: v.ID, Value: v}}); e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, v)
}
func (h *server) previewCollection(w http.ResponseWriter, r *http.Request) {
	v, ok := h.collectionInput(w, r)
	if !ok {
		return
	}
	result, e := h.resolveCollection(current(r).Account.ID, v)
	if e != nil {
		storeError(w, e)
		return
	}
	for i := range result.Endpoints {
		result.Endpoints[i] = redactEndpoint(result.Endpoints[i])
	}
	writeJSON(w, 200, result)
}
func (h *server) materializeProfile(owner string, p *Profile) error {
	return h.materializeProfileWithReader(owner, p, h.s)
}
func (h *server) materializeProfileWithReader(owner string, p *Profile, reader tenantRecordReader) error {
	if e := ensureID(&p.ID); e != nil {
		return e
	}
	if p.Name == "" {
		return fmt.Errorf("profile name required")
	}
	if e := sameOwner(&p.IR.OwnerID, owner); e != nil {
		return e
	}
	p.IR.ID = p.ID
	p.IR.Name = p.Name
	if p.IR.SchemaVersion == "" {
		p.IR.SchemaVersion = "1.0"
	}
	if p.IR.Revision == "" {
		p.IR.Revision = "draft"
	}
	entryRefs := map[string]bool{}
	for _, id := range p.PlatformEntryIDs {
		if entryRefs[id] {
			return fmt.Errorf("duplicate platform entry reference")
		}
		entryRefs[id] = true
	}
	imported := []domain.ClientEndpoint{}
	for i := range p.IR.Endpoints {
		entry := p.IR.Endpoints[i]
		if e := sameOwner(&entry.OwnerID, owner); e != nil {
			return e
		}
		if entry.Origin == "platform-entry" {
			if !entryRefs[entry.ID] {
				return fmt.Errorf("platform entries must reference an administrator-provisioned grant")
			}
			continue
		}
		if entry.Origin != "imported" {
			return fmt.Errorf("internal or unknown endpoint origin is not allowed")
		}
		imported = append(imported, entry)
	}
	p.IR.Endpoints = imported
	if len(p.IR.Resources) > resources.MaxBundleFiles {
		return fmt.Errorf("too many rule file resources")
	}
	var acceptedFileBytes int64
	for i := range p.IR.Resources {
		if e := sameOwner(&p.IR.Resources[i].OwnerID, owner); e != nil {
			return e
		}
		resource, err := h.resolveOwnedResource(owner, p.IR.Resources[i], reader)
		if err != nil {
			return err
		}
		acceptedFileBytes += resource.SizeBytes
		if acceptedFileBytes > resources.MaxBundleFileBytes {
			return fmt.Errorf("rule file resources exceed accepted size limit")
		}
		p.IR.Resources[i] = resource
	}
	if p.CollectionID != "" {
		var c domain.Collection
		if e := reader.TenantGet(owner, "collections", p.CollectionID, &c); e != nil {
			return fmt.Errorf("collection missing or not owned")
		}
		v, e := h.resolveCollectionWithReader(owner, c, reader)
		if e != nil {
			return e
		}
		p.IR.Endpoints = v.Endpoints
	} else if len(p.SourceIDs) > 0 {
		c := domain.Collection{ID: "profile-sources", Name: "Profile sources", OwnerID: owner}
		for _, id := range p.SourceIDs {
			c.Sources = append(c.Sources, domain.CollectionSource{SourceID: id})
		}
		v, e := h.resolveCollectionWithReader(owner, c, reader)
		if e != nil {
			return e
		}
		p.IR.Endpoints = v.Endpoints
	}
	for _, id := range p.PlatformEntryIDs {
		entry, e := h.resolveEntryWithReader(owner, id, reader)
		if e != nil {
			return e
		}
		p.IR.Endpoints = append(p.IR.Endpoints, entry)
	}
	return nil
}
func (h *server) resolveProfile(owner string, p *Profile) error {
	if e := h.materializeProfile(owner, p); e != nil {
		return e
	}
	return domain.ValidateClientProfile(p.IR)
}
func (h *server) saveProfile(w http.ResponseWriter, r *http.Request) {
	var p Profile
	if !decode(w, r, &p) {
		return
	}
	owner := current(r).Account.ID
	if e := ensureID(&p.ID); e != nil {
		storeError(w, e)
		return
	}
	if !pathMatches(r, p.ID) {
		fail(w, 400, "id mismatch")
		return
	}
	expected, e := h.expectedRecord(r, store.TenantKind(owner, "profiles"), p.ID)
	if e != nil {
		profileSaveError(w, e)
		return
	}
	inputs := newTemplateInputs(h.s)
	inputs.records[expected.Kind+"\x00"+p.ID] = *expected
	if e := h.materializeProfileWithReader(owner, &p, inputs); e != nil {
		storeError(w, e)
		return
	}
	p.Status = "draft"
	p.Diagnostics = []string{}
	if _, e := render.DefaultClients().Render(p.IR, p.Target, p.Mode); e != nil {
		p.Diagnostics = append(p.Diagnostics, e.Error())
	}
	p.UpdatedAt = time.Now().UTC()
	if e := h.s.CompareAndPutRecords(inputs.compares(), []store.RecordWrite{{Kind: store.TenantKind(owner, "profiles"), ID: p.ID, Value: p}}); e != nil {
		profileSaveError(w, e)
		return
	}
	raw, _ := json.Marshal(p)
	writeJSON(w, 200, h.tenantRecordView(owner, "profiles", raw, false))
}
func (h *server) previewProfile(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	var p Profile
	outputID, previewScope := "", "profile-draft"
	inputs := newTemplateInputs(h.s)
	if id := chi.URLParam(r, "id"); id != "" {
		if e := inputs.TenantGet(owner, "profiles", id, &p); e != nil {
			storeError(w, e)
			return
		}
		var in struct {
			OutputID string            `json:"outputId,omitempty"`
			Target   *render.Target    `json:"target,omitempty"`
			Mode     render.OutputMode `json:"mode,omitempty"`
		}
		if r.ContentLength != 0 {
			if !decode(w, r, &in) {
				return
			}
			if in.OutputID != "" {
				var output Output
				if err := inputs.TenantGet(owner, "outputs", in.OutputID, &output); err != nil {
					storeError(w, err)
					return
				}
				if output.ProfileID != p.ID {
					fail(w, 409, "output belongs to a different profile; preview its own profile")
					return
				}
				if (in.Target != nil && *in.Target != output.Target) || (in.Mode != "" && in.Mode != output.Mode) {
					fail(w, 409, "requested target or mode does not match the selected output")
					return
				}
				prepared, err := h.prepareOutput(owner, output, inputs)
				if err != nil {
					failProfileValidation(w, 422, err)
					return
				}
				writeProfilePreview(w, prepared.result, output.ID, "output-update", prepared.digest, &outputRoutingReview{SemanticChanges: compareOutputSemantics(output, prepared), NodeChanges: compareOutputNodes(output, prepared), PlatformEntryRefresh: platformEntryRefresh(in.OutputID, chi.URLParam(r, "id"), output, prepared), PublicationEffect: prepared.publicationEffect(), Candidate: prepared.output.RoutingSummary, Published: output.RoutingSummary, CandidateIntent: prepared.output.RoutingIntent, PublishedIntent: output.RoutingIntent})
				return
			} else {
				if in.Target != nil {
					p.Target = *in.Target
				}
				if in.Mode != "" {
					p.Mode = in.Mode
				}
			}
		}
	} else if !decode(w, r, &p) {
		return
	}
	if e := h.resolveProfile(owner, &p); e != nil {
		var missing *domain.MissingActionReferenceError
		if errors.As(e, &missing) {
			failProfileValidation(w, 400, e)
		} else {
			storeError(w, e)
		}
		return
	}
	v, e := render.DefaultClients().Render(p.IR, p.Target, p.Mode)
	if e != nil {
		failProfileValidation(w, 422, e)
		return
	}
	writeProfilePreview(w, v, outputID, previewScope, "", nil)
}
func (h *server) saveResource(w http.ResponseWriter, r *http.Request) {
	var v domain.RuleResource
	if !decode(w, r, &v) {
		return
	}
	if e := ensureID(&v.ID); e != nil {
		storeError(w, e)
		return
	}
	if !pathMatches(r, v.ID) {
		fail(w, 400, "id mismatch")
		return
	}
	owner := current(r).Account.ID
	if e := sameOwner(&v.OwnerID, owner); e != nil {
		fail(w, 403, e.Error())
		return
	}
	if v.AcceptedVersion != "" || v.Location == "local" || v.Visibility != "public" || v.UpdatePolicy == "pinned" {
		fail(w, 422, "import private, local, or pinned files through the accepted file endpoint")
		return
	}
	if e := domain.ValidateRuleResource(v); e != nil {
		storeError(w, e)
		return
	}
	if e := h.s.TenantPut(owner, "resources", v.ID, v); e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, v)
}

// collectionDependencies exposes only owner-scoped identities. This preview is not
// authorization: deleteTenant rechecks the full profile set at the mutation seam.
func (h *server) collectionDependencies(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	var collection domain.Collection
	if err := h.s.TenantGet(owner, "collections", chi.URLParam(r, "id"), &collection); err != nil {
		storeError(w, err)
		return
	}
	records, err := h.s.TenantList(owner, "profiles")
	if err != nil {
		storeError(w, err)
		return
	}
	profiles := []map[string]string{}
	for _, raw := range records {
		var profile Profile
		if err := json.Unmarshal(raw, &profile); err != nil {
			storeError(w, err)
			return
		}
		if profile.CollectionID == collection.ID {
			profiles = append(profiles, map[string]string{"id": profile.ID, "name": profile.Name})
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"collection": map[string]string{"id": collection.ID, "name": collection.Name}, "profiles": profiles, "deletable": len(profiles) == 0})
}

func (h *server) deleteTenant(owner, kind, id string) error {
	inputs := newTemplateInputs(h.s)
	var old json.RawMessage
	if e := inputs.TenantGet(owner, kind, id, &old); e != nil {
		return e
	}
	if kind == "sources" {
		all, e := inputs.TenantList(owner, "collections")
		if e != nil {
			return e
		}
		for _, b := range all {
			var v domain.Collection
			if e := json.Unmarshal(b, &v); e != nil {
				return e
			}
			for _, s := range v.Sources {
				if s.SourceID == id {
					return fmt.Errorf("source is referenced by collection %s", v.Name)
				}
			}
		}
	}
	if kind == "sources" || kind == "collections" || kind == "resources" {
		all, e := inputs.TenantList(owner, "profiles")
		if e != nil {
			return e
		}
		collectionDependents := []string{}
		for _, b := range all {
			var p Profile
			if e := json.Unmarshal(b, &p); e != nil {
				return e
			}
			if kind == "collections" && p.CollectionID == id {
				collectionDependents = append(collectionDependents, fmt.Sprintf("%s (%s)", p.Name, p.ID))
			}
			for _, ref := range p.SourceIDs {
				if kind == "sources" && ref == id {
					return fmt.Errorf("source is referenced by profile %s", p.Name)
				}
			}
			for _, ref := range p.IR.Resources {
				if kind == "resources" && ref.ID == id {
					return fmt.Errorf("resource is referenced by profile %s", p.Name)
				}
			}
		}
		if len(collectionDependents) > 0 {
			return fmt.Errorf("集合仍被以下配置引用，无法删除：%s", strings.Join(collectionDependents, "、"))
		}
	}
	if kind == "profiles" {
		all, e := inputs.TenantList(owner, "outputs")
		if e != nil {
			return e
		}
		for _, b := range all {
			var o Output
			if e := json.Unmarshal(b, &o); e != nil {
				return e
			}
			if o.ProfileID == id && o.Status != "revoked" {
				return fmt.Errorf("profile has an active subscription; revoke it before deleting")
			}
		}
	}
	removals := []store.RecordDelete{{Kind: store.TenantKind(owner, kind), ID: id}}
	if kind == "profiles" || kind == "collections" {
		bindingID := kind + "_" + id
		bindingKind := store.TenantKind(owner, "template-bindings")
		// Fence absence too: a concurrent selection must not leave a relationship
		// behind after its target is deleted, even if the draft itself is unchanged.
		if e := inputs.expectRecord(owner, "template-bindings", bindingID); e != nil {
			return e
		}
		if inputs.records[bindingKind+"\x00"+bindingID].Expected != nil {
			removals = append(removals, store.RecordDelete{Kind: bindingKind, ID: bindingID})
		}
	}
	return h.s.CompareSetsAndRemoveRecords(removals, inputs.compares(), inputs.sets)
}
