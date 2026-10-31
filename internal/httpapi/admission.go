package httpapi

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
	"time"
)

func (h *server) registerAdmissionAgent(r chi.Router) {
	r.Post("/agent/instances/{instanceId}/admission-leases", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var in entrypolicy.AdmissionRequest
		if !decode(w, r, &in) {
			return
		}
		scope := store.AdmissionScope{NodeID: enrollment.Scope.NodeID, InstanceID: enrollment.Scope.InstanceID, EnrollmentEpoch: enrollment.Scope.EnrollmentEpoch}
		decision, e := h.s.AcquireAdmission(scope, in, time.Now().UTC())
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, decision)
	})
	r.Delete("/agent/instances/{instanceId}/admission-leases/{leaseId}", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		scope := store.AdmissionScope{NodeID: enrollment.Scope.NodeID, InstanceID: enrollment.Scope.InstanceID, EnrollmentEpoch: enrollment.Scope.EnrollmentEpoch}
		if e := h.s.ReleaseAdmission(scope, chi.URLParam(r, "leaseId"), time.Now().UTC()); e != nil {
			storeError(w, e)
			return
		}
		w.WriteHeader(204)
	})
}
func (h *server) registerAdmissionAdmin(r chi.Router) {
	r.Get("/agent/instances/{instanceId}/admission-anomalies", func(w http.ResponseWriter, r *http.Request) {
		raw, e := h.s.List("admission-anomalies")
		if e != nil {
			storeError(w, e)
			return
		}
		out := []store.AdmissionAnomaly{}
		for _, b := range raw {
			var v store.AdmissionAnomaly
			if e = json.Unmarshal(b, &v); e != nil {
				storeError(w, e)
				return
			}
			if v.Scope.InstanceID == chi.URLParam(r, "instanceId") {
				out = append(out, v)
			}
		}
		writeJSON(w, 200, out)
	})
	r.Get("/agent/instances/{instanceId}/admission-budgets", func(w http.ResponseWriter, r *http.Request) {
		v, e := h.s.AdmissionBudgetReviews(chi.URLParam(r, "instanceId"), time.Now().UTC())
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/agent/instances/{instanceId}/admission-budgets/finalize", func(w http.ResponseWriter, r *http.Request) {
		var in store.AdmissionBudgetResolution
		if !decode(w, r, &in) {
			return
		}
		in.ActorID = current(r).Account.ID
		if e := h.s.ResolveAdmissionBudget(chi.URLParam(r, "instanceId"), in, time.Now().UTC()); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	r.Get("/agent/instances/{instanceId}/entry-bindings", func(w http.ResponseWriter, r *http.Request) {
		raw, e := h.s.List("entry-admission-bindings")
		if e != nil {
			storeError(w, e)
			return
		}
		out := []store.EntryAdmissionBinding{}
		for _, b := range raw {
			var v store.EntryAdmissionBinding
			if e = json.Unmarshal(b, &v); e != nil {
				storeError(w, e)
				return
			}
			if v.InstanceID == chi.URLParam(r, "instanceId") {
				out = append(out, v)
			}
		}
		writeJSON(w, 200, out)
	})
	r.Post("/agent/instances/{instanceId}/entry-bindings", func(w http.ResponseWriter, r *http.Request) {
		var binding store.EntryAdmissionBinding
		if !decode(w, r, &binding) {
			return
		}
		binding.InstanceID = chi.URLParam(r, "instanceId")
		if e := h.s.SetEntryAdmissionBinding(binding); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 201, binding)
	})
}
