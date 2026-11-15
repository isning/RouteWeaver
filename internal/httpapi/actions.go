package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"time"
)

type actionSummaryItem struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Href        string `json:"href"`
	Priority    string `json:"priority"`
}

type uncheckedOutputComparison struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
}

// These are observations of saved owner data, never client receipt or health.
// No refresh, remote inspection, publication, access-link reveal or mutation.
func (h *server) myActions(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	now := time.Now().UTC()
	w.Header().Set("Cache-Control", "no-store")
	rows, partial, err := h.s.TenantSummaryPage(r.Context(), owner, "outputs", 32, 2<<20)
	if err != nil {
		fail(w, 503, "Cannot check subscription actions. Please try again.")
		return
	}
	items := []actionSummaryItem{}
	unchecked := []uncheckedOutputComparison{}
	budget := 2 << 20
	preflighted := 0
	platformRoutesComplete := !partial
	platformRoutes := map[string]bool{}
	for _, raw := range rows {
		if r.Context().Err() != nil {
			return
		}
		var output Output
		if len(raw) > 512<<10 || json.Unmarshal(raw, &output) != nil {
			partial = true
			platformRoutesComplete = false
			continue
		}
		if output.Status != "published" {
			continue
		}
		if len(output.PlatformDependencies) > 64 {
			platformRoutesComplete = false
		} else {
			for _, dep := range output.PlatformDependencies {
				if dep.RouteID == "" || len(platformRoutes) >= 64 {
					platformRoutesComplete = false
					break
				}
				platformRoutes[dep.RouteID] = true
			}
		}
		deferCheck := func() {
			partial = true
			unchecked = append(unchecked, uncheckedOutputComparison{ID: output.ID, Revision: output.Revision})
		}
		if preflighted >= 8 {
			deferCheck()
			continue
		}
		inputs := newTemplateInputs(h.s)
		inputs.readBudget = &budget
		var profile Profile
		if inputs.TenantGet(owner, "profiles", output.ProfileID, &profile) != nil {
			deferCheck()
			continue
		}
		// Large/platform graphs remain available in selected review, not a
		// dashboard-wide compile. Never silently call skipped rows unchanged.
		if output.Attribution != nil || len(profile.PlatformEntryIDs) > 0 || (profile.IR.NativeOverride != nil && (profile.IR.NativeOverride.Format != "json" || len(profile.IR.NativeOverride.Content) > 4096)) || len(profile.SourceIDs) > 16 || len(profile.IR.Endpoints) > 256 || len(profile.IR.Rules) > 256 || len(profile.IR.Groups) > 64 || len(profile.IR.Resources) > 8 {
			deferCheck()
			continue
		}
		// Only eligible drafts enter the expensive-work budget. Failed preflights
		// still count; each admitted preflight permits at most one comparison.
		// Profile reads above remain bounded by the shared byte and scan limits.
		preflighted++
		if !actionCollectionWithinBudget(owner, profile, inputs) {
			deferCheck()
			continue
		}
		comparison := h.compareOutputDraft(owner, output, inputs)
		item := actionSummaryItem{ID: "output:" + output.ID, Href: "#subscriptions?output=" + url.QueryEscape(output.ID), Priority: "normal"}
		switch {
		case comparison["reason"] == "missing-action-reference":
			item.Kind = "output-reference-missing"
			item.Title = "订阅配置需要修复"
			item.Description = "有线路或分组已不存在，请重新选择。"
			item.Priority = "high"
		case comparison["state"] == "changed":
			item.Kind = "output-changed"
			item.Title = "订阅有改动待发布"
			item.Description = "查看变更后再发布，当前订阅仍使用已发布版本。"
		case comparison["state"] == "unchanged":
			continue
		default:
			deferCheck()
			continue
		}
		items = append(items, item)
	}
	routeIDs := []string{}
	if platformRoutesComplete {
		for id := range platformRoutes {
			routeIDs = append(routeIDs, id)
		}
	}
	sort.Strings(routeIDs)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Priority == "high" && items[j].Priority != "high" })
	writeJSON(w, 200, struct {
		AsOf                   time.Time                   `json:"asOf"`
		Items                  []actionSummaryItem         `json:"items"`
		Partial                bool                        `json:"partial"`
		UncheckedOutputs       []uncheckedOutputComparison `json:"uncheckedOutputs"`
		PlatformRouteIDs       []string                    `json:"platformRouteIds"`
		PlatformRoutesComplete bool                        `json:"platformRoutesComplete"`
	}{now, items, partial, unchecked, routeIDs, platformRoutesComplete})
}
