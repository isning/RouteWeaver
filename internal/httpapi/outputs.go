package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
	"strings"
	"time"
)

type EntryDependency struct {
	ID                string `json:"id"`
	RouteID           string `json:"routeId"`
	CredentialVersion string `json:"credentialVersion"`
	ConnectionDigest  string `json:"connectionDigest"`
}
type Output struct {
	SemanticSnapshot     *render.SemanticSnapshot         `json:"semanticSnapshot,omitempty"`
	RoutingIntent        *FrozenRoutingIntent             `json:"routingIntent,omitempty"`
	RoutingSummary       *RoutingSummary                  `json:"routingSummary,omitempty"`
	CreationReviewDigest string                           `json:"creationReviewDigest,omitempty"`
	ResourceFiles        []resources.RuleFile             `json:"resourceFiles,omitempty"`
	NameAllocations      map[string]domain.NameAllocation `json:"nameAllocations,omitempty"`
	PlatformDependencies []EntryDependency                `json:"platformDependencies,omitempty"`
	ID                   string                           `json:"id"`
	Name                 string                           `json:"name"`
	ProfileID            string                           `json:"profileId"`
	Target               render.Target                    `json:"target"`
	Mode                 render.OutputMode                `json:"mode"`
	Status               string                           `json:"status"`
	PublishedAt          *time.Time                       `json:"publishedAt,omitempty"`
	Revision             string                           `json:"revision,omitempty"`
	Token                string                           `json:"token,omitempty"`
	TokenDigest          string                           `json:"tokenDigest,omitempty"`
	Artifacts            []domain.Artifact                `json:"artifacts,omitempty"`
}

func outputView(o Output) map[string]any {
	view := map[string]any{"id": o.ID, "name": o.Name, "profileId": o.ProfileID, "target": o.Target, "mode": o.Mode, "status": o.Status, "publishedAt": o.PublishedAt, "revision": o.Revision}
	if o.CreationReviewDigest != "" {
		view["creationReviewDigest"] = o.CreationReviewDigest
	}
	if o.RoutingSummary != nil {
		view["routingSummary"] = o.RoutingSummary
	}
	view["delivery"] = "feed"
	view["downloadPath"] = "/api/me/outputs/" + o.ID + "/bundle"
	if len(o.ResourceFiles) > 0 {
		view["delivery"] = "bundle"
	}
	return view
}
func (h *server) registerOutputs(r chi.Router) {
	r.Get("/outputs/{id}/bundle", h.outputBundle)
	r.Get("/outputs/{id}/status", h.outputStatus)
	r.Get("/outputs/{id}/comparison", h.outputComparison)
	r.Post("/outputs/preview", h.previewNewOutput)
	r.Get("/outputs", func(w http.ResponseWriter, r *http.Request) {
		all, e := h.s.TenantList(current(r).Account.ID, "outputs")
		if e != nil {
			fail(w, 500, "cannot list outputs")
			return
		}
		out := []map[string]any{}
		for _, b := range all {
			var v Output
			if e = json.Unmarshal(b, &v); e != nil {
				fail(w, 500, "cannot read output")
				return
			}
			out = append(out, outputView(v))
		}
		writeJSON(w, 200, out)
	})
	r.Get("/outputs/{id}/access", func(w http.ResponseWriter, r *http.Request) {
		var v Output
		if e := h.s.TenantGet(current(r).Account.ID, "outputs", chi.URLParam(r, "id"), &v); e != nil {
			if errors.Is(e, store.ErrNotFound) {
				storeError(w, e)
			} else {
				fail(w, 503, "Subscription availability could not be checked. Please try again.")
			}
			return
		}
		if v.Status != "published" || v.Token == "" {
			fail(w, 409, "subscription is not published")
			return
		}
		state, err := h.outputAccessReadiness(current(r).Account.ID, v)
		if err != nil {
			if errors.Is(err, errOutputAccessUnknown) {
				fail(w, 503, "Subscription availability could not be checked. Please try again.")
			} else {
				fail(w, 409, "This subscription is currently unavailable. Please check your access.")
			}
			return
		}
		switch state {
		case outputEntryUnconfirmed:
			writeJSON(w, 409, map[string]string{"code": string(state), "detail": "The current platform entry has not been confirmed available. Check again before getting this subscription."})
			return
		case outputRepublishRequired:
			writeJSON(w, 409, map[string]string{"code": string(state), "detail": "This subscription uses an older platform credential. Review and update this subscription."})
			return
		}
		h.writeOutputAccess(w, v)
	})
	r.Post("/outputs", func(w http.ResponseWriter, r *http.Request) {
		var in outputCreationRequest
		if !decode(w, r, &in) {
			return
		}
		if e := ensureID(&in.ID); e != nil {
			storeError(w, e)
			return
		}
		owner := current(r).Account.ID
		var old Output
		if e := h.s.TenantGet(owner, "outputs", in.ID, &old); e == nil {
			fail(w, 409, "output id already exists")
			return
		}
		v := in.output()
		inputs := newTemplateInputs(h.s)
		prepared, e := h.prepareOutput(owner, v, inputs)
		if e != nil {
			if in.PreviewDigest != nil {
				fail(w, 409, "review is stale or no longer publishable; preview the output again")
			} else {
				fail(w, 422, e.Error())
			}
			return
		}
		if in.PreviewDigest != nil && (len(*in.PreviewDigest) != 64 || subtle.ConstantTimeCompare([]byte(*in.PreviewDigest), []byte(prepared.digest)) != 1) {
			fail(w, 409, "review is stale; preview the output again")
			return
		}
		v = prepared.output
		if in.PreviewDigest != nil {
			v.CreationReviewDigest = prepared.digest
		}
		if e = stampPublishedOutput(&v); e != nil {
			fail(w, 500, "cannot prepare publication")
			return
		}
		v.Token, e = auth.Token()
		if e != nil {
			fail(w, 500, "cannot issue feed link")
			return
		}
		v.TokenDigest = auth.Digest(v.Token)
		if e = h.s.CompareInputsAndPutWithToken(store.TenantKind(owner, "outputs"), v.ID, nil, v, "feeds", "", v.TokenDigest, owner+"/"+v.ID, inputs.compares(), inputs.sets); e != nil {
			storeError(w, e)
			return
		}
		out := outputView(v)
		out["feedPath"] = "/feed/" + v.Token
		out["bundlePath"] = "/feed/" + v.Token + "/bundle"
		writeJSON(w, 201, out)
	})
	r.Post("/outputs/{id}/publish", func(w http.ResponseWriter, r *http.Request) {
		owner := current(r).Account.ID
		var in struct {
			PreviewDigest *string `json:"previewDigest,omitempty"`
		}
		if r.ContentLength != 0 && !decode(w, r, &in) {
			return
		}
		inputs := newTemplateInputs(h.s)
		var expected Output
		if e := inputs.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &expected); e != nil {
			storeError(w, e)
			return
		}
		prepared, e := h.prepareOutput(owner, expected, inputs)
		if e != nil {
			if in.PreviewDigest != nil {
				fail(w, 409, "review is stale or no longer publishable; preview the output again")
			} else {
				fail(w, 422, e.Error())
			}
			return
		}
		if in.PreviewDigest != nil && (len(*in.PreviewDigest) != 64 || subtle.ConstantTimeCompare([]byte(*in.PreviewDigest), []byte(prepared.digest)) != 1) {
			fail(w, 409, "review is stale; preview the output again")
			return
		}
		v := prepared.output
		v.CreationReviewDigest = "" // A later publication is not the reviewed creation.
		if e = stampPublishedOutput(&v); e != nil {
			fail(w, 500, "cannot prepare publication")
			return
		}
		if v.Token == "" {
			v.Token, e = auth.Token()
			if e != nil {
				fail(w, 500, "cannot issue feed link")
				return
			}
			v.TokenDigest = auth.Digest(v.Token)
		}
		if e = h.s.CompareInputsAndPutWithToken(store.TenantKind(owner, "outputs"), v.ID, expected, v, "feeds", expected.TokenDigest, v.TokenDigest, owner+"/"+v.ID, inputs.compares(), inputs.sets); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, outputView(v))
	})
	r.Post("/outputs/{id}/rotate", func(w http.ResponseWriter, r *http.Request) {
		owner := current(r).Account.ID
		var v Output
		if e := h.s.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &v); e != nil {
			storeError(w, e)
			return
		}
		if v.Status != "published" {
			fail(w, 409, "publish the output first")
			return
		}
		expected := v
		if e := h.rotate(owner, &v, &expected); e != nil {
			storeError(w, e)
			return
		}
		out := outputView(v)
		out["feedPath"] = "/feed/" + v.Token
		out["bundlePath"] = "/feed/" + v.Token + "/bundle"
		writeJSON(w, 200, out)
	})
	r.Post("/outputs/{id}/revoke", func(w http.ResponseWriter, r *http.Request) {
		owner := current(r).Account.ID
		var v Output
		if e := h.s.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &v); e != nil {
			storeError(w, e)
			return
		}
		expected := v
		old := v.TokenDigest
		v.Status = "revoked"
		v.Token = ""
		v.TokenDigest = ""
		if e := h.s.CompareAndPutWithToken(store.TenantKind(owner, "outputs"), v.ID, expected, v, "feeds", old, "", ""); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, outputView(v))
	})
}
func (h *server) publish(owner string, v *Output) error {
	prepared, e := h.prepareOutput(owner, *v, newTemplateInputs(h.s))
	if e != nil {
		return e
	}
	*v = prepared.output
	return stampPublishedOutput(v)
}
func stampPublishedOutput(v *Output) error {
	now := time.Now().UTC()
	rev, e := auth.Token()
	if e != nil {
		return e
	}
	v.PublishedAt = &now
	v.Revision = rev
	v.Status = "published"
	return nil
}
func (h *server) rotate(owner string, v *Output, expected *Output) error {
	old := v.TokenDigest
	token, e := auth.Token()
	if e != nil {
		return e
	}
	v.Token = token
	v.TokenDigest = auth.Digest(token)
	var previous any
	if expected != nil {
		previous = *expected
	}
	return h.s.CompareAndPutWithToken(store.TenantKind(owner, "outputs"), v.ID, previous, v, "feeds", old, v.TokenDigest, owner+"/"+v.ID)
}
func (h *server) feed(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if len(token) != 43 {
		fail(w, 404, "subscription unavailable")
		return
	}
	digest := auth.Digest(token)
	ref, e := h.s.LookupToken("feeds", digest)
	if e != nil {
		fail(w, 404, "subscription unavailable")
		return
	}
	parts := strings.SplitN(ref, "/", 2)
	if len(parts) != 2 {
		fail(w, 404, "subscription unavailable")
		return
	}
	var v Output
	if e = h.s.TenantGet(parts[0], "outputs", parts[1], &v); e != nil || v.Status != "published" || v.TokenDigest != digest || len(v.Artifacts) != 1 {
		fail(w, 404, "subscription unavailable")
		return
	}
	overview, e := h.authorizeOutputDelivery(parts[0], v)
	if e != nil {
		fail(w, 403, e.Error())
		return
	}
	if len(v.ResourceFiles) > 0 {
		fail(w, 409, "this output includes local rule files; download its configuration and file bundle")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="routeweaver.json"`)
	w.Header().Set("Profile-Update-Interval", "6")
	if overview != nil {
		userinfo := fmt.Sprintf("upload=0; download=%d; total=%d", overview.Usage.WeightedBytes, overview.QuotaBytes)
		if overview.Entitlement.ExpiresAt != nil {
			userinfo += fmt.Sprintf("; expire=%d", overview.Entitlement.ExpiresAt.Unix())
		}
		w.Header().Set("Subscription-Userinfo", userinfo)
	}
	w.WriteHeader(200)
	w.Write([]byte(v.Artifacts[0].Content))
}

func connectionDigest(v domain.Connection) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
