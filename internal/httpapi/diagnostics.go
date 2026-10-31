package httpapi

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/resources"
	"time"
)

func diagnosticError(w http.ResponseWriter, e error) {
	if errors.Is(e, diagnostics.ErrScope) {
		fail(w, 403, e.Error())
		return
	}
	storeError(w, e)
}
func (h *server) registerDiagnosticAdmin(r chi.Router) {
	r.Get("/admin/diagnostic-paths", func(w http.ResponseWriter, r *http.Request) {
		paths, e := h.s.DiagnosticPaths(time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 200, paths)
	})
	r.Get("/admin/diagnostic-targets", func(w http.ResponseWriter, r *http.Request) { h.listGlobal(w, "diagnostic-targets") })
	r.Post("/admin/diagnostic-targets", func(w http.ResponseWriter, r *http.Request) {
		var target diagnostics.Target
		if !decode(w, r, &target) {
			return
		}
		// No remote URL supplied to a job, no source credential reuse, and no HTTP,
		// private-network or fixture bypass on the public administration interface.
		if resources.ValidateHTTPSURL(target.URL) != nil {
			fail(w, 400, "diagnostic target must be public HTTPS without credentials, query or fragment")
			return
		}
		if e := h.s.CreateDiagnosticTarget(target, current(r).Account.ID, time.Now().UTC()); e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 201, target)
	})
	r.Get("/admin/diagnostic-jobs", func(w http.ResponseWriter, r *http.Request) {
		jobs, e := h.s.DiagnosticJobs(time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 200, jobs)
	})
	r.Post("/admin/diagnostic-jobs", func(w http.ResponseWriter, r *http.Request) {
		var request diagnostics.Request
		if !decode(w, r, &request) {
			return
		}
		job, e := h.s.RequestDiagnostic(request, current(r).Account.ID, time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 201, job)
	})
	r.Get("/admin/diagnostic-jobs/{jobId}", func(w http.ResponseWriter, r *http.Request) {
		job, e := h.s.DiagnosticJob(chi.URLParam(r, "jobId"), time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 200, job)
	})
	r.Post("/admin/diagnostic-jobs/{jobId}/cancel", func(w http.ResponseWriter, r *http.Request) {
		job, e := h.s.CancelDiagnostic(chi.URLParam(r, "jobId"), current(r).Account.ID, time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 200, job)
	})
}
func (h *server) registerDiagnosticAgent(r chi.Router) {
	base := "/agent/instances/{instanceId}/diagnostics"
	r.Post(base+"/claim", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var in struct {
			AttemptID string `json:"attemptId"`
		}
		if !decode(w, r, &in) {
			return
		}
		job, e := h.s.ClaimDiagnostic(enrollment.Scope, in.AttemptID, time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		if job == nil {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, job)
	})
	r.Get(base+"/{jobId}", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		job, e := h.s.DiagnosticJobForScope(chi.URLParam(r, "jobId"), enrollment.Scope, time.Now().UTC())
		if e != nil {
			diagnosticError(w, e)
			return
		}
		writeJSON(w, 200, job)
	})
	r.Post(base+"/{jobId}/result", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var report diagnostics.Report
		if !decode(w, r, &report) {
			return
		}
		if report.Scope != enrollment.Scope || report.JobID != chi.URLParam(r, "jobId") {
			fail(w, 403, "diagnostic result scope mismatch")
			return
		}
		if e := h.s.AcceptDiagnosticReport(report, time.Now().UTC()); e != nil {
			diagnosticError(w, e)
			return
		}
		w.WriteHeader(204)
	})
}
