package httpapi

import (
	"context"
	"net/http"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"time"
)

type insightLimits struct {
	OnlineIPLimit   int   `json:"onlineIpLimit"`
	ConnectionLimit int   `json:"connectionLimit"`
	EntryRateBPS    int64 `json:"entryRateBps"`
}
type insightsResponse struct {
	store.UsageInsights
	Cycle  service.CycleWindow `json:"cycle"`
	Limits insightLimits       `json:"limits"`
}

func (h *server) myInsights(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// No caller-selected identity or unbounded range. The authenticated account
	// owns every returned ledger bucket and lease; no raw records are exposed.
	if len(r.URL.Query()) != 0 {
		fail(w, 400, "insights does not accept query parameters")
		return
	}
	user := current(r).Account.ID
	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	usage, policy, cycle, e := h.s.UserInsightsContext(ctx, user, now)
	if e != nil {
		fail(w, 503, "usage insights temporarily unavailable; retry later")
		return
	}

	writeJSON(w, 200, insightsResponse{usage, cycle, insightLimits{policy.OnlineIPLimit, policy.ConnectionLimit, policy.EntryRateBPS}})
}
