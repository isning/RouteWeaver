package httpapi

import (
	"context"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/notifications"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"time"
)

func nodeObservationError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, store.ErrNotFound):
		fail(w, 404, "node or observer instance not found")
	case errors.Is(e, observability.ErrScope):
		fail(w, 403, "only the designated enrolled instance may observe this node")
	case errors.Is(e, observability.ErrConflict):
		fail(w, 409, e.Error())
	default:
		fail(w, 400, e.Error())
	}
}
func (h *server) registerNodeObservationAgent(r chi.Router) {
	r.Post("/agent/instances/{instanceId}/node-observations", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var report observability.Report
		if !decode(w, r, &report) {
			return
		}
		if report.Scope != observability.Scope(enrollment.Scope) {
			fail(w, 403, "node observation enrollment scope mismatch")
			return
		}
		receipt, e := h.s.AcceptNodeObservation(report, time.Now().UTC())
		if e != nil {
			nodeObservationError(w, e)
			return
		}
		writeJSON(w, 200, receipt)
	})
}
func (h *server) registerNodeObservationAdmin(r chi.Router) {
	const base = "/admin/nodes/{nodeId}/observability"
	r.Get(base, func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "nodeId")
		state, e := h.s.NodeObservations(id)
		if e != nil {
			nodeObservationError(w, e)
			return
		}
		writeJSON(w, 200, observability.ViewOf(id, state, time.Now().UTC()))
	})
	r.Get(base+"/history", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		window := r.URL.Query().Get("window")
		if window == "" {
			window = "24h"
		}
		if window != "1h" && window != "24h" && window != "7d" {
			fail(w, 400, "invalid history window")
			return
		}
		view, err := h.s.NodeResourceHistory(ctx, chi.URLParam(r, "nodeId"), time.Now().UTC(), window)
		if errors.Is(err, store.ErrNotFound) {
			fail(w, 404, "node not found")
			return
		}
		if err != nil {
			fail(w, 503, "resource history unavailable; retry later")
			return
		}
		writeJSON(w, 200, view)
	})
	r.Put(base+"/config", func(w http.ResponseWriter, r *http.Request) {
		var in observability.Config
		if !decode(w, r, &in) {
			return
		}
		id := chi.URLParam(r, "nodeId")
		state, e := h.s.ConfigureNodeObservations(id, in)
		if e != nil {
			nodeObservationError(w, e)
			return
		}
		if e = h.s.Audit(current(r).Account.ID, "node-observer.configured", id); e != nil {
			fail(w, 500, "configuration saved; audit could not be recorded")
			return
		}
		writeJSON(w, 200, observability.ViewOf(id, state, time.Now().UTC()))
	})
	r.Post(base+"/baseline", func(w http.ResponseWriter, r *http.Request) {
		var in observability.BaselineInput
		if !decode(w, r, &in) {
			return
		}
		id := chi.URLParam(r, "nodeId")
		now := time.Now().UTC()
		state, e := h.s.ReconcileNodeProvider(id, in, current(r).Account.ID, now)
		if e != nil {
			nodeObservationError(w, e)
			return
		}
		writeJSON(w, 200, observability.ViewOf(id, state, now))
	})
	r.Post(base+"/provider-statement", func(w http.ResponseWriter, r *http.Request) {
		var in observability.StatementInput
		if !decode(w, r, &in) {
			return
		}
		id := chi.URLParam(r, "nodeId")
		now := time.Now().UTC()
		state, e := h.s.RecordNodeProviderStatement(id, in, current(r).Account.ID, now)
		if e != nil {
			nodeObservationError(w, e)
			return
		}
		writeJSON(w, 200, observability.ViewOf(id, state, now))
	})
}

// Only an explicit, complete and fresh configured provider source reaches the
// notification evaluator. User/route accounting and multipliers are never read.
func (h *server) evaluateProviderAllowances(now time.Time) error {
	return h.evaluateProviderAllowancesContext(context.Background(), now)
}
func (h *server) evaluateProviderAllowancesContext(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	inputs, e := h.s.NotificationProviderInputs(ctx)
	if e != nil {
		return e
	}
	for _, input := range inputs {
		if err := ctx.Err(); err != nil {
			return err
		}
		host, state := input.Host, input.State
		view := observability.ViewOf(host.ID, state, now)
		if !view.Provider.NotificationEligible {
			continue
		}
		c, p := state.Config.Provider, view.Provider
		snapshot := notifications.ProviderSnapshot{Source: p.Source, ID: host.ID, Name: c.Name, CycleID: c.CycleID, RemainingBytes: *p.RemainingBytes, TotalBytes: *p.TotalBytes, ExpiresAt: c.ExpiresAt, ObservedAt: *p.ObservedAt}
		if e = h.notificationService().EvaluateProviderContext(ctx, snapshot, now); e != nil {
			return e
		}
	}
	return nil
}
