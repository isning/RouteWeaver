package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"time"
)

func (h *server) registerAccessPolicyAdmin(r chi.Router) {
	r.Get("/access-policy/edit-context/service/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		context, err := h.s.ServicePolicyEditContext(chi.URLParam(r, "id"))
		if err != nil {
			writePolicyEditError(w, err, "service")
			return
		}
		writeJSON(w, 200, context)
	})
	r.Get("/access-policy/edit-context/group/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		context, err := h.s.GroupPolicyEditContext(chi.URLParam(r, "id"))
		if err != nil {
			writePolicyEditError(w, err, "group")
			return
		}
		writeJSON(w, 200, context)
	})
	r.Get("/access-policy/edit-context/entitlement/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		context, err := h.s.EntitlementPolicyEditContext(chi.URLParam(r, "id"), time.Now().UTC())
		if err != nil {
			writePolicyEditError(w, err, "entitlement")
			return
		}
		writeJSON(w, 200, context)
	})
	r.Get("/users/{id}/admission-status", func(w http.ResponseWriter, r *http.Request) {
		status, e := h.s.AdmissionStatus(chi.URLParam(r, "id"), time.Now().UTC())
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, status)
	})
	r.Get("/user-groups", func(w http.ResponseWriter, r *http.Request) { h.listGlobal(w, "user-groups") })
	r.Get("/users/{id}/effective-policy", func(w http.ResponseWriter, r *http.Request) {
		policy, e := h.s.EffectivePolicy(chi.URLParam(r, "id"), time.Now().UTC())
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, policy)
	})
	r.Post("/access-policy/preview", func(w http.ResponseWriter, r *http.Request) {
		change, expected, ok := decodePolicyPreviewRequest(w, r)
		if !ok {
			return
		}
		var result service.PolicyPreview
		var e error
		if expected != nil {
			result, e = h.s.PreviewPolicyEdit(change, *expected, time.Now().UTC())
		} else {
			// Explicit compatibility contract: raw PolicyChange means deliberate
			// replacement. Guarded envelopes never fall back to this branch.
			result, e = h.s.PreviewPolicyChange(change, time.Now().UTC())
		}
		if e != nil {
			writePolicyEditError(w, e, policyEditErrorKind(change))
			return
		}
		writeJSON(w, 200, result)
	})
	r.Post("/access-policy/apply", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Change   service.PolicyChange `json:"change"`
			Revision string               `json:"revision"`
		}
		if !decode(w, r, &in) {
			return
		}
		result, e := h.s.ApplyPolicyChange(in.Change, in.Revision, time.Now().UTC())
		if e != nil {
			storeError(w, e)
			return
		}
		target := ""
		if in.Change.Group != nil {
			target = "group:" + in.Change.Group.ID
		}
		if in.Change.Service != nil {
			target = "service:" + in.Change.Service.ID
		}
		if in.Change.Entitlement != nil {
			target = "user:" + in.Change.Entitlement.UserID
		}
		if e = h.s.Audit(current(r).Account.ID, "access-policy.applied", target); e != nil {
			fail(w, 500, "policy applied; audit could not be recorded")
			return
		}
		writeJSON(w, 200, result)
	})
}

func policyEditErrorKind(change service.PolicyChange) string {
	if change.Group != nil {
		return "group"
	}
	if change.Entitlement != nil {
		return "entitlement"
	}
	return "service"
}

func writePolicyEditError(w http.ResponseWriter, err error, kind string) {
	object, subject := "方案", "服务方案"
	if kind == "group" {
		object, subject = "用户组", "用户组"
	} else if kind == "entitlement" {
		object, subject = "个人授权", "个人授权"
	}
	switch {
	case errors.Is(err, store.ErrPolicyEditPreconditionRequired):
		writeJSON(w, http.StatusPreconditionRequired, map[string]string{"code": "POLICY_EDIT_PRECONDITION_REQUIRED", "detail": "无法核对打开时的" + object + "版本。当前输入已保留，请重新打开" + object + "。"})
	case errors.Is(err, store.ErrPolicyEditBaselineChanged):
		writeJSON(w, http.StatusConflict, map[string]string{"code": "POLICY_EDIT_BASELINE_CHANGED", "detail": subject + "已更新。当前草稿尚未保存，请查看最新版本。"})
	case errors.Is(err, store.ErrPolicyEditUnsupportedRecord):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "POLICY_EDIT_UNSUPPORTED_RECORD", "detail": "已保存的" + object + "包含当前编辑器不支持的字段或格式，无法安全编辑。"})
	default:
		storeError(w, err)
	}
}

func decodePolicyValue(raw json.RawMessage, value any) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return false
	}
	var extra any
	return decoder.Decode(&extra) == io.EOF
}

func decodePolicyPreviewRequest(w http.ResponseWriter, r *http.Request) (service.PolicyChange, *service.PolicyEditPrecondition, bool) {
	var change service.PolicyChange
	var raw json.RawMessage
	if !decode(w, r, &raw) {
		return change, nil, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		fail(w, 400, "invalid policy preview request")
		return change, nil, false
	}
	_, hasChange := fields["change"]
	_, hasPrecondition := fields["precondition"]
	if hasChange || hasPrecondition {
		for key := range fields {
			if key != "change" && key != "precondition" {
				fail(w, 400, "guarded and replacement policy shapes cannot be mixed")
				return change, nil, false
			}
		}
		if !hasChange || bytes.Equal(bytes.TrimSpace(fields["change"]), []byte("null")) || !decodePolicyValue(fields["change"], &change) {
			fail(w, 400, "invalid guarded policy change")
			return change, nil, false
		}
		if !hasPrecondition || bytes.Equal(bytes.TrimSpace(fields["precondition"]), []byte("null")) {
			writePolicyEditError(w, store.ErrPolicyEditPreconditionRequired, policyEditErrorKind(change))
			return change, nil, false
		}
		var expected struct {
			Exists   *bool  `json:"exists"`
			Revision string `json:"revision"`
		}
		if !decodePolicyValue(fields["precondition"], &expected) {
			fail(w, 400, "invalid policy edit precondition")
			return change, nil, false
		}
		if expected.Exists == nil || expected.Revision == "" {
			writePolicyEditError(w, store.ErrPolicyEditPreconditionRequired, policyEditErrorKind(change))
			return change, nil, false
		}
		return change, &service.PolicyEditPrecondition{Exists: *expected.Exists, Revision: expected.Revision}, true
	}
	if !decodePolicyValue(raw, &change) {
		fail(w, 400, "invalid policy replacement")
		return change, nil, false
	}
	return change, nil, true
}
