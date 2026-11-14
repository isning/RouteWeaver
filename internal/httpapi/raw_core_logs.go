package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/diagnostics"
	"strings"
	"time"
	"unicode/utf8"
)

func rawCoreError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, diagnostics.ErrRawCoreConflict):
		fail(w, 409, "raw core log sequence conflict")
	case errors.Is(e, diagnostics.ErrRawCoreRate):
		fail(w, 429, "raw core log reporting is rate limited")
	case errors.Is(e, diagnostics.ErrRawCoreCapacity):
		fail(w, 503, "raw core log capacity reached")
	default:
		coreDiagnosticError(w, e)
	}
}
func (h *server) registerRawCoreLogAgent(r chi.Router) {
	r.Post("/agent/instances/{instanceId}/core-logs", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
		var report diagnostics.RawCoreReport
		if !decode(w, r, &report) {
			return
		}
		if report.Scope != enrollment.Scope {
			fail(w, 403, "raw core log scope mismatch")
			return
		}
		receipt, e := h.s.AcceptRawCoreLogs(report, time.Now().UTC())
		if e != nil {
			rawCoreError(w, e)
			return
		}
		writeJSON(w, 200, receipt)
	})
}
func (h *server) registerRawCoreLogAdmin(r chi.Router) {
	r.Get("/admin/instances/{instanceId}/core-logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		query := r.URL.Query()
		stream, q, format := query.Get("stream"), query.Get("q"), query.Get("format")
		if (stream != "" && stream != "stdout" && stream != "stderr") || len(q) > 128 || !utf8.ValidString(q) || (format != "" && format != "ndjson") {
			fail(w, 400, "invalid raw core log filter")
			return
		}
		now := time.Now().UTC()
		since := now.Add(-diagnostics.RawCoreRetention)
		if v := query.Get("since"); v != "" {
			var e error
			since, e = time.Parse(time.RFC3339, v)
			if e != nil || since.After(now.Add(time.Minute)) {
				fail(w, 400, "invalid log time filter")
				return
			}
		}
		id := chi.URLParam(r, "instanceId")
		history, e := h.s.RawCoreLogs(id, now)
		if e != nil {
			rawCoreError(w, e)
			return
		}
		events := []diagnostics.RawCoreRecord{}
		for _, event := range history.Events {
			if (stream == "" || event.Stream == stream) && (q == "" || strings.Contains(event.Text, q)) && !event.ObservedAt.Before(since) {
				events = append(events, event)
			}
		}
		if format == "ndjson" {
			w.Header().Set("Content-Type", "application/x-ndjson")
			w.Header().Set("Content-Disposition", `attachment; filename="core-logs.ndjson"`)
			enc := json.NewEncoder(w)
			for _, event := range events {
				if enc.Encode(event) != nil {
					return
				}
			}
			return
		}
		state := "not_reported"
		if history.LastReceivedAt != nil {
			state = "stale"
			if now.Sub(*history.LastReceivedAt) < 30*time.Second {
				state = "recent"
			}
		}
		writeJSON(w, 200, map[string]any{"instanceId": id, "collectionState": state, "lastReceivedAt": history.LastReceivedAt, "events": events, "dropped": history.Dropped, "retentionSeconds": 3600, "historyLimit": diagnostics.RawCoreHistoryLimit, "lineBytesLimit": 4096})
	})
}
