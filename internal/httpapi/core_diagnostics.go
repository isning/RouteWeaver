package httpapi

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"time"
)

func coreDiagnosticError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, diagnostics.ErrScope):
		fail(w, 403, "core diagnostic enrollment scope mismatch")
	case errors.Is(e, diagnostics.ErrCoreConflict):
		fail(w, 409, "core diagnostic sequence conflict")
	case errors.Is(e, diagnostics.ErrCoreRate):
		fail(w, 429, "core diagnostic reporting is rate limited")
	case errors.Is(e, diagnostics.ErrCoreCapacity):
		fail(w, 503, "core diagnostic capacity reached")
	case errors.Is(e, diagnostics.ErrInvalid):
		fail(w, 400, "invalid core diagnostic report")
	case errors.Is(e, store.ErrNotFound):
		fail(w, 404, "core instance not found")
	default:
		fail(w, 500, "core diagnostics unavailable")
	}
}
func (h *server) registerCoreDiagnosticAgent(r chi.Router) {
	r.Post("/agent/instances/{instanceId}/core-diagnostics", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		var report diagnostics.CoreReport
		if !decode(w, r, &report) {
			return
		}
		if report.Scope != enrollment.Scope {
			fail(w, 403, "core diagnostic scope mismatch")
			return
		}
		receipt, e := h.s.AcceptCoreDiagnostics(report, time.Now().UTC())
		if e != nil {
			coreDiagnosticError(w, e)
			return
		}
		writeJSON(w, 200, receipt)
	})
}
func (h *server) registerCoreDiagnosticAdmin(r chi.Router) {
	r.Get("/admin/instances/{instanceId}/core-diagnostics", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "instanceId")
		now := time.Now().UTC()
		var instance domain.CoreInstance
		if e := h.s.Get("core-instances", id, &instance); e != nil {
			coreDiagnosticError(w, e)
			return
		}
		history, e := h.s.CoreDiagnostics(id, now)
		if e != nil {
			coreDiagnosticError(w, e)
			return
		}
		state := "not_reported"
		supported := diagnostics.CoreSupported(instance.AdapterID, instance.Version)
		if !supported {
			state = "unsupported"
		} else if history.LastReceivedAt != nil {
			state = "stale"
			if now.Sub(*history.LastReceivedAt) < 30*time.Second {
				state = "recent"
			}
		}
		writeJSON(w, 200, map[string]any{"instanceId": id, "supported": supported, "collectionState": state, "lastReceivedAt": history.LastReceivedAt, "events": history.Events, "omitted": history.Omitted, "dropped": history.Dropped, "retentionHours": 24, "historyLimit": diagnostics.CoreHistoryLimit})
	})
}
