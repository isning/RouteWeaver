package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/reuse"
	"routeweaver/internal/store"
)

const templateKind = "template-library"

type TemplateVersion struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	Version     int        `json:"version"`
	Digest      string     `json:"digest"`
	Spec        reuse.Spec `json:"spec"`
	PublishedAt time.Time  `json:"publishedAt"`
	PublishedBy string     `json:"publishedBy"`
}
type templateLibrary struct {
	ID       string            `json:"id"`
	Kind     string            `json:"kind"`
	Versions []TemplateVersion `json:"versions"`
}
type templateBinding struct {
	ID             string                  `json:"id"`
	TemplateID     string                  `json:"templateId"`
	TargetKind     string                  `json:"targetKind"`
	TargetID       string                  `json:"targetId"`
	Mode           string                  `json:"mode"`
	AppliedVersion int                     `json:"appliedVersion"`
	VersionDigest  string                  `json:"versionDigest"`
	Bindings       reuse.Bindings          `json:"bindings"`
	Target         render.Target           `json:"target"`
	BaseSteps      []domain.ProcessingStep `json:"baseSteps,omitempty"`
	BaseProfile    domain.ClientProfileIR  `json:"baseProfile,omitempty"`
	UpdatedAt      time.Time               `json:"updatedAt"`
}

// Review is response-only declared routing, not an applied or published artifact.
type templateRoutingReviewSide struct {
	State  string               `json:"state"`
	Intent *FrozenRoutingIntent `json:"intent,omitempty"`
	Reason string               `json:"reason,omitempty"`
}
type templateRoutingReview struct {
	Version   int                       `json:"version"`
	Scope     string                    `json:"scope"`
	Current   templateRoutingReviewSide `json:"current"`
	Candidate templateRoutingReviewSide `json:"candidate"`
}
type templatePreview struct {
	Review              *templateRoutingReview `json:"review,omitempty"`
	BindingID           string                 `json:"bindingId"`
	Mode                string                 `json:"mode"`
	CurrentVersion      int                    `json:"currentVersion"`
	CandidateVersion    int                    `json:"candidateVersion"`
	HasUpdate           bool                   `json:"hasUpdate"`
	Compatible          bool                   `json:"compatible"`
	NativeChecked       bool                   `json:"nativeChecked"`
	PreviewDigest       string                 `json:"previewDigest"`
	Changes             []string               `json:"changes"`
	PreservedLocalEdits []string               `json:"preservedLocalEdits"`
	Diagnostics         []string               `json:"diagnostics"`
	Artifacts           []domain.Artifact      `json:"artifacts,omitempty"`
}
type templateCandidate struct {
	view       templatePreview
	binding    templateBinding
	old        json.RawMessage
	oldBinding json.RawMessage
	next       any
	inputs     *templateInputs
}

func (h *server) registerTemplates(r chi.Router) {
	r.Get("/templates", h.listTemplates)
	r.Get("/templates/{id}/versions", h.templateVersions)
	r.With(requireAdmin).Post("/admin/templates", h.publishTemplate)
	r.With(requireAdmin).Post("/admin/templates/sanitize", h.sanitizeTemplate)
	r.Post("/me/templates/{id}/select", h.selectTemplate)
	r.Get("/me/template-bindings", h.listTemplateBindings)
	r.Post("/me/template-bindings/{id}/preview", h.previewTemplateUpdate)
	r.Post("/me/template-bindings/{id}/apply", h.applyTemplateUpdate)
}
func (h *server) listTemplates(w http.ResponseWriter, r *http.Request) {
	all, e := h.s.List(templateKind)
	if e != nil {
		storeError(w, e)
		return
	}
	out := []TemplateVersion{}
	for _, raw := range all {
		var v templateLibrary
		if json.Unmarshal(raw, &v) != nil || len(v.Versions) == 0 {
			fail(w, 500, "cannot read template library")
			return
		}
		out = append(out, v.Versions[len(v.Versions)-1])
	}
	writeJSON(w, 200, out)
}
func (h *server) templateVersions(w http.ResponseWriter, r *http.Request) {
	var v templateLibrary
	if e := h.s.Get(templateKind, chi.URLParam(r, "id"), &v); e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, v.Versions)
}
func (h *server) publishTemplate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID              string     `json:"id"`
		Name            string     `json:"name"`
		Kind            string     `json:"kind"`
		ExpectedVersion int        `json:"expectedVersion"`
		Spec            reuse.Spec `json:"spec"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !domain.ValidID(in.ID) || !reuse.ValidName(in.Name) || in.ExpectedVersion < 0 {
		fail(w, 400, "template identity, name and expectedVersion required")
		return
	}
	if e := reuse.Validate(in.Kind, in.Spec); e != nil {
		fail(w, 422, e.Error())
		return
	}
	var published TemplateVersion
	e := h.s.UpdateRecords(templateKind, in.ID, func(raw json.RawMessage) ([]store.RecordWrite, error) {
		lib := templateLibrary{ID: in.ID, Kind: in.Kind, Versions: []TemplateVersion{}}
		if len(raw) > 0 {
			if e := json.Unmarshal(raw, &lib); e != nil {
				return nil, e
			}
		}
		if lib.Kind != in.Kind {
			return nil, fmt.Errorf("template kind cannot change")
		}
		if len(lib.Versions) != in.ExpectedVersion {
			return nil, store.ErrConflict
		}
		published = TemplateVersion{ID: in.ID, Name: in.Name, Kind: in.Kind, Version: len(lib.Versions) + 1, Spec: in.Spec, PublishedAt: time.Now().UTC(), PublishedBy: current(r).Account.ID}
		published.Digest = templateDigest(struct {
			Kind string
			Spec reuse.Spec
		}{in.Kind, in.Spec})
		lib.Versions = append(lib.Versions, published)
		return []store.RecordWrite{{Kind: templateKind, ID: in.ID, Value: lib}}, nil
	})
	if e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 201, published)
}
func (h *server) sanitizeTemplate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind     string `json:"kind"`
		TargetID string `json:"targetId"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner := current(r).Account.ID
	var spec reuse.Spec
	var e error
	switch in.Kind {
	case reuse.ProcessingPreset:
		var c domain.Collection
		if e = h.s.TenantGet(owner, "collections", in.TargetID, &c); e == nil {
			spec, e = reuse.SanitizeSteps(c.Steps)
		}
	case reuse.ClientProfile:
		var p Profile
		if e = h.s.TenantGet(owner, "profiles", in.TargetID, &p); e == nil {
			spec, e = reuse.SanitizeProfile(p.IR)
		}
	default:
		fail(w, 400, "unknown template kind")
		return
	}
	if e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"kind": in.Kind, "spec": spec, "requiresReview": true, "notice": "Private connections and rule resource locations are binding slots. Health-check URLs use the fixed public default. Review before publishing."})
}
func (h *server) templateVersion(id string, version int) (TemplateVersion, error) {
	var lib templateLibrary
	if e := h.s.Get(templateKind, id, &lib); e != nil {
		return TemplateVersion{}, e
	}
	if version == 0 {
		version = len(lib.Versions)
	}
	if version < 1 || version > len(lib.Versions) {
		return TemplateVersion{}, store.ErrNotFound
	}
	return lib.Versions[version-1], nil
}
func bindingView(v templateBinding) map[string]any {
	return map[string]any{"id": v.ID, "templateId": v.TemplateID, "targetKind": v.TargetKind, "targetId": v.TargetID, "mode": v.Mode, "appliedVersion": v.AppliedVersion, "versionDigest": v.VersionDigest, "bindings": v.Bindings, "target": v.Target, "updatedAt": v.UpdatedAt}
}
func (h *server) listTemplateBindings(w http.ResponseWriter, r *http.Request) {
	all, e := h.s.TenantList(current(r).Account.ID, "template-bindings")
	if e != nil {
		storeError(w, e)
		return
	}
	out := []map[string]any{}
	for _, raw := range all {
		var b templateBinding
		if e = json.Unmarshal(raw, &b); e != nil {
			storeError(w, e)
			return
		}
		out = append(out, bindingView(b))
	}
	writeJSON(w, 200, out)
}
func (h *server) selectTemplate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Version  int            `json:"version"`
		Mode     string         `json:"mode"`
		TargetID string         `json:"targetId"`
		Bindings reuse.Bindings `json:"bindings"`
		Target   render.Target  `json:"target"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !domain.ValidID(in.TargetID) || (in.Mode != reuse.Copy && in.Mode != reuse.Pinned && in.Mode != reuse.Follow) {
		fail(w, 400, "targetId and copy, pinned or follow mode required")
		return
	}
	v, e := h.templateVersion(chi.URLParam(r, "id"), in.Version)
	if e != nil {
		storeError(w, e)
		return
	}
	kind := "profiles"
	if v.Kind == reuse.ProcessingPreset {
		kind = "collections"
	}
	targetProvided := in.Target.AdapterID != ""
	if !targetProvided {
		in.Target = render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	}
	if kind == "collections" && (len(in.Bindings.Endpoints) != 0 || len(in.Bindings.Resources) != 0) {
		fail(w, 400, "processing presets do not accept profile binding slots")
		return
	}
	binding := templateBinding{ID: kind + "_" + in.TargetID, TemplateID: v.ID, TargetKind: kind, TargetID: in.TargetID, Mode: in.Mode, Bindings: in.Bindings, Target: in.Target}
	var oldBinding json.RawMessage
	if err := h.s.TenantGet(current(r).Account.ID, "template-bindings", binding.ID, &oldBinding); err != nil && !errors.Is(err, store.ErrNotFound) {
		storeError(w, err)
		return
	}
	initial := true
	if len(oldBinding) > 0 {
		var previous templateBinding
		if err := json.Unmarshal(oldBinding, &previous); err != nil {
			storeError(w, err)
			return
		}
		if previous.TemplateID == binding.TemplateID && previous.TargetKind == binding.TargetKind {
			binding.BaseSteps = previous.BaseSteps
			if in.Bindings.Endpoints == nil && in.Bindings.Resources == nil {
				binding.Bindings = previous.Bindings
			}
			if !targetProvided {
				binding.Target = previous.Target
			}
			binding.BaseProfile = previous.BaseProfile
			binding.AppliedVersion = previous.AppliedVersion
			binding.VersionDigest = previous.VersionDigest
			initial = false
		}
	}
	candidate, e := h.buildTemplateCandidate(current(r).Account.ID, binding, v, initial)
	candidate.oldBinding = oldBinding
	if e != nil {
		storeError(w, e)
		return
	}
	if !candidate.view.Compatible {
		writeJSON(w, 422, candidate.view)
		return
	}
	if e = h.commitTemplateCandidate(current(r).Account.ID, candidate); e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"binding": bindingView(candidate.binding), "preview": candidate.view})
}
func (h *server) updateCandidate(owner, id string, bindings *reuse.Bindings, requestedVersion int) (templateCandidate, error) {
	var b templateBinding
	var oldBinding json.RawMessage
	if e := h.s.TenantGet(owner, "template-bindings", id, &oldBinding); e != nil {
		return templateCandidate{}, e
	}
	if e := json.Unmarshal(oldBinding, &b); e != nil {
		return templateCandidate{}, e
	}
	if b.Mode == reuse.Copy {
		return templateCandidate{}, fmt.Errorf("independent copies do not receive upstream updates")
	}
	if requestedVersion < 0 {
		return templateCandidate{}, fmt.Errorf("version must be positive when specified")
	}
	version := requestedVersion
	if version == 0 && b.Mode == reuse.Pinned {
		version = b.AppliedVersion
	}
	v, e := h.templateVersion(b.TemplateID, version)
	if e != nil {
		return templateCandidate{}, e
	}
	if b.TargetKind == "collections" && bindings != nil && (len(bindings.Endpoints) != 0 || len(bindings.Resources) != 0) {
		return templateCandidate{}, fmt.Errorf("processing presets do not accept profile binding slots")
	}
	changed := bindings != nil && !reflect.DeepEqual(b.Bindings, *bindings)
	if bindings != nil {
		b.Bindings = *bindings
	}
	c, err := h.buildTemplateCandidate(owner, b, v, false)
	c.oldBinding = oldBinding
	if changed {
		c.view.HasUpdate = true
	}
	return c, err
}
func (h *server) previewTemplateUpdate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Bindings *reuse.Bindings `json:"bindings,omitempty"`
		Version  int             `json:"version,omitempty"`
	}
	if r.ContentLength != 0 && !decode(w, r, &in) {
		return
	}
	c, e := h.updateCandidate(current(r).Account.ID, chi.URLParam(r, "id"), in.Bindings, in.Version)
	if e != nil {
		if errors.Is(e, store.ErrNotFound) {
			storeError(w, e)
		} else {
			fail(w, 409, e.Error())
		}
		return
	}
	writeJSON(w, 200, c.view)
}
func (h *server) applyTemplateUpdate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PreviewDigest string          `json:"previewDigest"`
		Bindings      *reuse.Bindings `json:"bindings,omitempty"`
		Version       int             `json:"version,omitempty"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner := current(r).Account.ID
	c, e := h.updateCandidate(owner, chi.URLParam(r, "id"), in.Bindings, in.Version)
	if e != nil {
		storeError(w, e)
		return
	}
	if in.PreviewDigest == "" || in.PreviewDigest != c.view.PreviewDigest {
		fail(w, 409, "template or personal configuration changed; preview again before applying")
		return
	}
	if !c.view.Compatible {
		writeJSON(w, 422, c.view)
		return
	}
	if !c.view.HasUpdate {
		writeJSON(w, 200, map[string]any{"binding": bindingView(c.binding), "preview": c.view})
		return
	}
	if e = h.commitTemplateCandidate(owner, c); e != nil {
		storeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"binding": bindingView(c.binding), "preview": c.view})
}

func (h *server) buildTemplateCandidate(owner string, b templateBinding, v TemplateVersion, initial bool) (templateCandidate, error) {
	c := templateCandidate{binding: b, view: templatePreview{BindingID: b.ID, Mode: b.Mode, CurrentVersion: b.AppliedVersion, CandidateVersion: v.Version, HasUpdate: initial || v.Version != b.AppliedVersion, Compatible: true, Changes: []string{}, PreservedLocalEdits: []string{}, Diagnostics: []string{}}}
	c.inputs = newTemplateInputs(h.s)
	if e := c.inputs.TenantGet(owner, b.TargetKind, b.TargetID, &c.old); e != nil {
		return c, e
	}
	switch b.TargetKind {
	case "collections":
		if v.Kind != reuse.ProcessingPreset {
			return c, fmt.Errorf("template kind no longer matches collection")
		}
		var old domain.Collection
		if e := json.Unmarshal(c.old, &old); e != nil {
			return c, e
		}
		next := old
		base := b.BaseSteps
		if initial {
			base = nil
		}
		next.Steps, c.view.PreservedLocalEdits = reuse.MergeSteps(base, old.Steps, v.Spec.ProcessingSteps())
		if !reflect.DeepEqual(old.Steps, next.Steps) {
			c.view.Changes = append(c.view.Changes, "steps")
		}
		c.next = next
		c.binding.BaseSteps = v.Spec.ProcessingSteps()
		result, e := h.resolveCollectionWithReader(owner, next, c.inputs)
		if e == nil {
			p := domain.ClientProfileIR{SchemaVersion: "1.0", ID: "preset-preview", Name: "Processing preview", OwnerID: owner, Revision: "preview", Endpoints: result.Endpoints, DefaultAction: domain.ActionRef{Kind: "direct"}, Runtime: domain.ClientRuntime{MixedPort: 7890}}
			var rendered render.ClientResult
			rendered, e = render.DefaultClients().Render(p, b.Target, render.FullConfig)
			c.view.Artifacts = rendered.Artifacts
		}
		if e == nil {
			e = h.validatePresetDependents(owner, next, result.Endpoints, c.inputs)
		}
		if e != nil {
			c.view.Compatible = false
			c.view.Diagnostics = append(c.view.Diagnostics, e.Error())
		}
	case "profiles":
		if v.Kind != reuse.ClientProfile {
			return c, fmt.Errorf("template kind no longer matches profile")
		}
		var old Profile
		if e := json.Unmarshal(c.old, &old); e != nil {
			return c, e
		}
		// Decode independently: materialization replaces resource slice elements.
		// A shallow copy of old would mutate its backing array during capture.
		var currentProfile Profile
		if e := json.Unmarshal(c.old, &currentProfile); e != nil {
			return c, e
		}
		e := h.materializeProfileWithReader(owner, &currentProfile, c.inputs)
		next := currentProfile
		if e == nil && next.Mode != render.FullConfig {
			e = fmt.Errorf("client profile templates require full configuration output; nodes-only cannot preserve routing intent")
		}
		var baseline domain.ClientProfileIR
		if e == nil {
			baseline, e = v.Spec.Instantiate(next.IR, b.Bindings)
		}
		if e == nil {
			if initial {
				next.IR, c.view.PreservedLocalEdits = reuse.AdoptProfile(next.IR, baseline)
			} else {
				next.IR, c.view.PreservedLocalEdits = reuse.MergeProfile(b.BaseProfile, next.IR, baseline)
			}
			c.binding.BaseProfile = templatePolicy(baseline)
			c.binding.Target = next.Target
			if !reflect.DeepEqual(old.IR.Groups, next.IR.Groups) {
				c.view.Changes = append(c.view.Changes, "groups")
			}
			if !reflect.DeepEqual(old.IR.Rules, next.IR.Rules) {
				c.view.Changes = append(c.view.Changes, "rules")
			}
			if !reflect.DeepEqual(old.IR.DefaultAction, next.IR.DefaultAction) {
				c.view.Changes = append(c.view.Changes, "defaultAction")
			}
			if !reflect.DeepEqual(old.IR.Runtime, next.IR.Runtime) {
				c.view.Changes = append(c.view.Changes, "runtime")
			}
			var rendered render.ClientResult
			rendered, e = render.DefaultClients().Render(next.IR, next.Target, next.Mode)
			c.view.Artifacts = rendered.Artifacts
			if e == nil && !initial {
				c.view.Review = summarizeTemplateRoutingReview(currentProfile, next, rendered)
			}
		}
		if e != nil {
			c.view.Compatible = false
			c.view.Diagnostics = append(c.view.Diagnostics, e.Error())
		}
		next.Status = "draft"
		next.Diagnostics = []string{}
		next.UpdatedAt = time.Now().UTC()
		c.next = next
	default:
		return c, fmt.Errorf("unknown template target kind")
	}
	for i := range c.view.Artifacts {
		c.view.Artifacts[i].Content = redactArtifact(c.view.Artifacts[i].Content)
	}
	sort.Strings(c.view.PreservedLocalEdits)
	// Time-independent digest binds the exact reviewed input, baseline, upstream
	// version, target and user source material. Apply recomputes this before CAS.
	c.view.PreviewDigest = templateDigest(struct {
		Old     json.RawMessage
		Binding templateBinding
		Version TemplateVersion
		Next    any
		Inputs  []store.RecordCompare
		Sets    []store.RecordSetCompare
	}{c.old, b, v, stableCandidate(c.next), c.inputs.compares(), c.inputs.sets})
	c.binding.AppliedVersion = v.Version
	c.binding.VersionDigest = v.Digest
	c.binding.UpdatedAt = time.Now().UTC()
	return c, nil
}
func (h *server) validatePresetDependents(owner string, c domain.Collection, endpoints []domain.ClientEndpoint, inputs *templateInputs) error {
	all, e := inputs.profiles(owner)
	if e != nil {
		return e
	}
	for _, raw := range all {
		var p Profile
		if e = json.Unmarshal(raw, &p); e != nil {
			return e
		}
		if p.CollectionID != c.ID {
			continue
		}
		if e = h.materializeProfileWithReader(owner, &p, inputs); e != nil {
			return fmt.Errorf("dependent profile %s: %w", p.Name, e)
		}
		own := []domain.ClientEndpoint{}
		for _, ep := range p.IR.Endpoints {
			if ep.Origin == "platform-entry" {
				own = append(own, ep)
			}
		}
		p.IR.Endpoints = append(append([]domain.ClientEndpoint{}, endpoints...), own...)
		if _, e = render.DefaultClients().Render(p.IR, p.Target, p.Mode); e != nil {
			return fmt.Errorf("dependent profile %s: %w", p.Name, e)
		}
	}
	return nil
}
func (h *server) commitTemplateCandidate(owner string, c templateCandidate) error {
	var expectedBinding any
	if len(c.oldBinding) > 0 {
		expectedBinding = c.oldBinding
	}
	compares := append(c.inputs.compares(), []store.RecordCompare{
		{Kind: store.TenantKind(owner, c.binding.TargetKind), ID: c.binding.TargetID, Expected: c.old},
		{Kind: store.TenantKind(owner, "template-bindings"), ID: c.binding.ID, Expected: expectedBinding},
	}...)
	return h.s.CompareSetsAndPutRecords(compares, c.inputs.sets, []store.RecordWrite{
		{Kind: store.TenantKind(owner, c.binding.TargetKind), ID: c.binding.TargetID, Value: c.next},
		{Kind: store.TenantKind(owner, "template-bindings"), ID: c.binding.ID, Value: c.binding},
	})
}
func templatePolicy(p domain.ClientProfileIR) domain.ClientProfileIR {
	return domain.ClientProfileIR{Groups: p.Groups, Rules: p.Rules, DefaultAction: p.DefaultAction, Runtime: p.Runtime}
}
func stableCandidate(v any) any {
	if p, ok := v.(Profile); ok {
		p.UpdatedAt = time.Time{}
		return p
	}
	return v
}
func templateDigest(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Both sides come from the same captured inputs. Before compilation is advisory:
// a broken current draft must not prevent an otherwise valid repair candidate.
func summarizeTemplateRoutingReview(currentProfile, candidate Profile, candidateRender render.ClientResult) *templateRoutingReview {
	side := func(p Profile, rendered render.ClientResult) templateRoutingReviewSide {
		intent := summarizeFrozenRoutingIntent(p.IR, p.Mode, rendered.Names, maxFrozenRoutingIntentBytes)
		if intent == nil {
			return templateRoutingReviewSide{State: "unavailable", Reason: "size-limit"}
		}
		return templateRoutingReviewSide{State: "available", Intent: intent}
	}
	review := &templateRoutingReview{Version: 1, Scope: "profile-routing", Candidate: side(candidate, candidateRender)}
	before, err := render.DefaultClients().Render(currentProfile.IR, currentProfile.Target, currentProfile.Mode)
	if err != nil {
		review.Current = templateRoutingReviewSide{State: "unavailable", Reason: "render-failed"}
	} else {
		review.Current = side(currentProfile, before)
	}
	return review
}
