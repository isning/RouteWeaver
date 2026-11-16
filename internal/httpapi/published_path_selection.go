package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

// This operation selects an existing proven path; it never transforms server
// programs, moves an ingress, changes credentials, or applies a deployment.
type pathSelectionInput struct {
	ExpectedRouteRevision string                     `json:"expectedRouteRevision"`
	Hops                  []domain.PublishedRouteHop `json:"hops"`
	ReviewToken           string                     `json:"reviewToken,omitempty"`
}
type pathSelectionReview struct {
	RouteID       string               `json:"routeId"`
	ReviewToken   string               `json:"reviewToken"`
	Before        publishedPathSummary `json:"before"`
	After         publishedPathSummary `json:"after"`
	Candidate     publishedRouteInput  `json:"candidate"`
	Status        string               `json:"status"`
	RevisionToken string               `json:"revisionToken"`
}
type preparedPathSelection struct {
	proof  preparedFleet
	route  domain.PublishedRoute
	links  []domain.Link
	review pathSelectionReview
}

func (h *server) preparePathSelection(actor, id string, in pathSelectionInput) (preparedPathSelection, error) {
	out := preparedPathSelection{}
	var old domain.PublishedRoute
	if err := h.strictExitRead(&out.proof, "published-routes", id, &old); err != nil {
		return out, err
	}
	if old.ID != id || !sameReviewToken(in.ExpectedRouteRevision, h.recordRevision("published-routes", id, out.proof.Compares[0].Expected)) {
		return out, store.ErrConflict
	}
	oldHops, err := domain.ResolvePublishedRouteHops(old)
	if err != nil || len(in.Hops) == 0 || len(in.Hops) > 64 || in.Hops[0].Kind != "managed" || in.Hops[0].EndpointID != oldHops[0].EndpointID {
		return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "请保留原入口并选择完整转发路径。")
	}
	var deployment ServerDeployment
	if err = h.strictExitRead(&out.proof, "server-deployments", old.DeploymentID, &deployment); err != nil {
		return out, err
	}
	if deployment.ID != old.DeploymentID || deployment.IR.ID != old.DeploymentID {
		return out, store.ErrConflict
	}
	candidate := publishedRouteInput{ID: old.ID, Name: old.Name, DeploymentID: old.DeploymentID, Hops: in.Hops, PublicHost: old.PublicHost, PublicPort: old.PublicPort}
	out.route, out.links, err = h.preparePublishedRouteWithProof(candidate, &out.proof)
	if err != nil {
		return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "所选路径与已保存的转发设置不一致，请重新核对。")
	}
	// prepare uses its own dependency reads. Use exactly that captured deployment
	// for the returned view and the principal proof, not a later summary read.
	for _, c := range out.proof.Compares {
		if c.Kind == "server-deployments" && c.ID == old.DeploymentID {
			raw, e := json.Marshal(c.Expected)
			if e != nil || strictSupported(raw, &deployment) != nil {
				return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "已保存转发设置包含不支持的字段。")
			}
		}
	}
	endpoints := make([]domain.ManagedEndpoint, 0, len(out.route.EndpointIDs))
	for _, id := range out.route.EndpointIDs {
		var endpoint domain.ManagedEndpoint
		if err = h.strictExitRead(&out.proof, "managed-endpoints", id, &endpoint); err != nil {
			return out, err
		}
		if endpoint.ID != id {
			return out, store.ErrConflict
		}
		endpoints = append(endpoints, endpoint)
	}
	action, err := h.publishedPathActionWithProof(deployment.IR, out.route, endpoints, &out.proof)
	if err != nil {
		return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "无法确认已保存的完整转发路径。")
	}
	for _, p := range deployment.IR.Programs {
		if p.Listener.ID != old.Path.Entry {
			continue
		}
		_, defaultAction, actionErr := publishedProgramConnectors(p)
		if actionErr != nil || defaultAction != action {
			return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "请选择已保存配置的完整默认路径。")
		}
		for _, principal := range p.Principals {
			if principal.RouteID == id && principal.Action != action {
				return out, exitBlocked("PATH_SELECTION_PRINCIPAL_CHANGED", "已保存的用户入口与所选路径不一致，请先核对转发设置。")
			}
		}
	}
	if samePublishedRouteSnapshot(old, out.route) {
		return out, exitBlocked("PATH_SELECTION_UNCHANGED", "当前线路已使用这条完整路径。")
	}
	var legacy domain.Route
	if err = h.fleetRead(&out.proof, "routes", id, &legacy, true); err != nil {
		return out, err
	}
	if legacy.ID != "" {
		return out, store.ErrConflict
	}
	// Every typed dependency used in the proof must be understood. A future
	// forwarding or identity field cannot silently disappear through decoding.
	for _, c := range out.proof.Compares {
		if c.Expected == nil {
			continue
		}
		var value any
		switch c.Kind {
		case "published-routes":
			value = &domain.PublishedRoute{}
		case "server-deployments":
			value = &ServerDeployment{}
		case "managed-endpoints":
			value = &domain.ManagedEndpoint{}
		case "core-instances":
			value = &domain.CoreInstance{}
		case "hosts":
			value = &domain.Host{}
		case "links":
			value = &domain.Link{}
		case "routes":
			value = &domain.Route{}
		default:
			return out, store.ErrConflict
		}
		raw, e := json.Marshal(c.Expected)
		if e != nil || strictSupported(raw, value) != nil {
			return out, exitBlocked("PATH_SELECTION_UNSUPPORTED", "相关设置包含不支持的字段，请先核对。")
		}
	}
	candidate.EndpointIDs = append([]string(nil), out.route.EndpointIDs...)
	token, err := h.s.ReviewToken("path-selection/v1/"+actor+"/"+id, struct {
		Candidate publishedRouteInput
		Compares  []store.RecordCompare
		Sets      []store.RecordSetCompare
	}{candidate, out.proof.Compares, out.proof.Sets})
	if err != nil {
		return out, err
	}
	out.review = pathSelectionReview{RouteID: id, ReviewToken: token, Before: summarizePublishedRoute(old, deployment.IR.Programs), After: summarizePublishedRoute(out.route, deployment.IR.Programs), Candidate: candidate, Status: "reviewed", RevisionToken: in.ExpectedRouteRevision}
	return out, nil
}

// Return only deliberate public refusals. Renderer, storage and credential
// errors are not suitable response bodies for a path-selection operation.
func writePathSelectionError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "PATH_SELECTION_CHANGED", "detail": "线路或转发设置已变化，请重新检查完整路径。"})
		return
	}
	var safe *exitChangeError
	if errors.As(err, &safe) && len(safe.code) >= len("PATH_SELECTION_") && safe.code[:len("PATH_SELECTION_")] == "PATH_SELECTION_" {
		writeJSON(w, safe.status, map[string]string{"code": safe.code, "detail": safe.detail})
		return
	}
	writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "PATH_SELECTION_UNAVAILABLE", "detail": "暂时无法检查完整路径，请重试。"})
}

func (h *server) registerPathSelection(r chi.Router) {
	handle := func(commit bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var in pathSelectionInput
			if !decode(w, r, &in) {
				return
			}
			id := chi.URLParam(r, "id")
			if !domain.ValidID(id) {
				fail(w, 400, "invalid route identity")
				return
			}
			prepared, err := h.preparePathSelection(current(r).Account.ID, id, in)
			if err != nil {
				writePathSelectionError(w, err)
				return
			}
			if commit {
				if !sameReviewToken(in.ReviewToken, prepared.review.ReviewToken) {
					writePathSelectionError(w, store.ErrConflict)
					return
				}
				writes := []store.RecordWrite{{Kind: "published-routes", ID: id, Value: prepared.route}}
				for _, link := range prepared.links {
					writes = append(writes, store.RecordWrite{Kind: "links", ID: link.ID, Value: link})
				}
				if err = h.s.CompareSetsAndPutRecords(prepared.proof.Compares, prepared.proof.Sets, writes); err != nil {
					writePathSelectionError(w, err)
					return
				}
				prepared.review.Status = "draft-saved"
				prepared.review.RevisionToken = h.recordRevision("published-routes", id, prepared.route)
				h.s.Audit(current(r).Account.ID, "published-route.path-selected", id)
			}
			writeJSON(w, 200, prepared.review)
		}
	}
	r.Post("/published-routes/{id}/path-selection/preview", handle(false))
	r.Post("/published-routes/{id}/path-selection", handle(true))
}
