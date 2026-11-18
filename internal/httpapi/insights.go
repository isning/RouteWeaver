package httpapi

import (
	"context"
	"net/http"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strconv"
	"time"
)

type insightLimits struct {
	OnlineIPLimit   int   `json:"onlineIpLimit"`
	ConnectionLimit int   `json:"connectionLimit"`
	EntryRateBPS    int64 `json:"entryRateBps"`
}
type insightsResponse struct {
	IPMetadata ipMetadataView `json:"ipMetadata"`
	store.UsageInsights
	Cycle  service.CycleWindow `json:"cycle"`
	Limits insightLimits       `json:"limits"`
}

func (h *server) myInsights(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// No caller-selected identity or unbounded range. The authenticated account
	// owns every returned ledger bucket and lease; no raw records are exposed.
	days := 14
	query := r.URL.Query()
	for key := range query {
		if key != "days" {
			fail(w, 400, "unsupported insights parameter")
			return
		}
	}
	if values, ok := query["days"]; ok {
		var err error
		if len(values) != 1 {
			fail(w, 400, "days must be between 1 and 30")
			return
		}
		days, err = strconv.Atoi(values[0])
		if err != nil || days < 1 || days > 30 {
			fail(w, 400, "days must be between 1 and 30")
			return
		}
	}
	user := current(r).Account.ID
	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	usage, policy, cycle, e := h.s.UserInsightsContext(ctx, user, now, days)
	if e != nil {
		fail(w, 503, "usage insights temporarily unavailable; retry later")
		return
	}

	writeJSON(w, 200, insightsResponse{IPMetadata: h.ipMetadata(usage.Admission.OnlineIPs), UsageInsights: usage, Cycle: cycle, Limits: insightLimits{policy.OnlineIPLimit, policy.ConnectionLimit, policy.EntryRateBPS}})
}
