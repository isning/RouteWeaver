package httpapi

import (
	"net/http"
	"time"
)

func (h *server) myOutputUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len(r.URL.Query()) != 0 {
		fail(w, 400, "output usage does not accept query parameters")
		return
	}
	result, err := h.s.OutputUsageInsightsContext(r.Context(), current(r).Account.ID, time.Now().UTC())
	if err != nil {
		fail(w, 503, "subscription usage is temporarily unavailable; no partial totals returned")
		return
	}
	writeJSON(w, 200, result)
}
