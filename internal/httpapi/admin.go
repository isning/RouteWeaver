package httpapi

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"time"
)

type Settings struct {
	Name         string `json:"name"`
	Timezone     string `json:"timezone"`
	Registration string `json:"registration"`
}

func (h *server) registerAdmin(r chi.Router) {
	h.registerSubscriptionOriginAdmin(r)
	h.registerAccessPolicyAdmin(r)
	h.registerFleetAdmin(r)
	h.registerNodeObservationAdmin(r)
	h.registerEntryAdmin(r)
	h.registerAgentAdmin(r)
	h.registerServerAdmin(r)
	h.registerPublishedRouteAdmin(r)
	r.Get("/users/{id}/entitlement", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		o, e := h.overview(id, time.Now())
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, o.Entitlement)
	})
	r.Post("/invites", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name           string `json:"name"`
			Role           string `json:"role"`
			ExpiresInHours int    `json:"expiresInHours"`
		}
		if !decode(w, r, &in) {
			return
		}
		if in.Role == "" {
			in.Role = "user"
		}
		if in.ExpiresInHours == 0 {
			in.ExpiresInHours = 24
		}
		if in.ExpiresInHours < 1 || in.ExpiresInHours > 168 {
			fail(w, 400, "invite expiry must be 1–168 hours")
			return
		}
		v, token, e := h.s.CreateInvite(in.Name, in.Role, time.Now().Add(time.Duration(in.ExpiresInHours)*time.Hour))
		if e != nil {
			storeError(w, e)
			return
		}
		h.s.Audit(current(r).Account.ID, "invite.created", v.ID)
		writeJSON(w, 201, map[string]any{"id": v.ID, "token": token, "name": v.Name, "role": v.Role, "expiresAt": v.ExpiresAt})
	})
	r.Get("/services", func(w http.ResponseWriter, r *http.Request) { h.listGlobal(w, "services") })
	savePlan := func(w http.ResponseWriter, r *http.Request) {
		var v service.Plan
		if !decode(w, r, &v) {
			return
		}
		if !domain.ValidID(v.ID) || v.Name == "" || v.QuotaBytes < 0 || v.OnlineIPLimit < 0 || v.ConnectionLimit < 0 || v.EntryRateBPS < 0 {
			fail(w, 400, "invalid service plan")
			return
		}
		if id := chi.URLParam(r, "id"); id != "" && id != v.ID {
			fail(w, 400, "id mismatch")
			return
		}
		validationPolicy := v.Cycle
		if validationPolicy.Anchor.IsZero() {
			validationPolicy.Anchor = time.Now()
		}
		if e := validationPolicy.Validate(); e != nil {
			storeError(w, e)
			return
		}
		st, e := h.s.State()
		if e != nil {
			fail(w, 500, "cannot read routes")
			return
		}
		known := map[string]bool{}
		for _, x := range st.Routes {
			known[x.ID] = true
		}
		managed, e := h.s.List("published-routes")
		if e != nil {
			storeError(w, e)
			return
		}
		for _, raw := range managed {
			var route domain.PublishedRoute
			if e = json.Unmarshal(raw, &route); e != nil {
				storeError(w, e)
				return
			}
			known[route.ID] = true
		}
		for _, id := range v.RouteIDs {
			if !known[id] {
				fail(w, 400, "service references unknown route")
				return
			}
		}
		if e = h.s.PutServicePlan(v); e != nil {
			storeError(w, e)
			return
		}
		h.s.Audit(current(r).Account.ID, "service.saved", v.ID)
		writeJSON(w, 200, v)
	}
	r.Post("/services", savePlan)
	r.Put("/services/{id}", savePlan)
	r.Get("/settings", func(w http.ResponseWriter, r *http.Request) {
		v := Settings{Name: "RouteWeaver", Timezone: "UTC+8", Registration: "invite"}
		if e := h.s.Get("settings", "platform", &v); e != nil && e != store.ErrNotFound {
			fail(w, 500, "cannot read settings")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Put("/settings", func(w http.ResponseWriter, r *http.Request) {
		var v Settings
		if !decode(w, r, &v) {
			return
		}
		if v.Name == "" || v.Timezone != "UTC+8" || v.Registration != "invite" {
			fail(w, 400, "name required; timezone UTC+8 and invite-only registration are supported")
			return
		}
		if e := h.s.Put("settings", "platform", v); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, v)
	})
	r.Get("/rates", func(w http.ResponseWriter, r *http.Request) {
		v, e := h.s.Rates()
		if e != nil {
			fail(w, 500, "cannot read rates")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/rates", func(w http.ResponseWriter, r *http.Request) {
		var v service.Rate
		if !decode(w, r, &v) {
			return
		}
		if e := h.s.SetRate(v); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 201, v)
	})
	r.Post("/usage", func(w http.ResponseWriter, r *http.Request) {
		var v store.MeterBatch
		if !decode(w, r, &v) {
			return
		}
		if e := h.s.RecordMeter(v); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	r.Put("/users/{id}/entitlement", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var v service.Entitlement
		if !decode(w, r, &v) {
			return
		}
		v.UserID = id
		var previous service.Entitlement
		previousErr := h.s.Get("entitlements", id, &previous)
		if previousErr != nil && previousErr != store.ErrNotFound {
			storeError(w, previousErr)
			return
		}
		var u domain.User
		if e := h.s.Get("users", id, &u); e != nil {
			storeError(w, e)
			return
		}
		if v.Cycle.Mode == "" && previousErr == nil {
			v.Cycle = previous.Cycle
		}
		if v.ServiceID != "" {
			var p service.Plan
			if e := h.s.Get("services", v.ServiceID, &p); e != nil {
				fail(w, 400, "unknown service")
				return
			}
			if v.Cycle.Mode == "" {
				v.Cycle = p.Cycle
			}
		}
		if v.StartsAt.IsZero() {
			if previousErr == nil {
				v.StartsAt = previous.StartsAt
			} else {
				v.StartsAt = time.Now().UTC()
			}
		}
		policyChanged := previousErr != nil || v.Cycle.Mode != previous.Cycle.Mode || v.Cycle.Day != previous.Cycle.Day || v.Cycle.Days != previous.Cycle.Days || !v.StartsAt.Equal(previous.StartsAt)
		if policyChanged {
			v.Cycle.Anchor = v.StartsAt
		} else {
			v.Cycle.Anchor = previous.Cycle.Anchor
		}
		if v.Cycle.Mode == "" {
			v.Cycle.Mode = "none"
		}
		if e := v.Cycle.Validate(); e != nil {
			storeError(w, e)
			return
		}
		if v.ExpiresAt != nil && !v.ExpiresAt.After(v.StartsAt) || v.QuotaOverride != nil && *v.QuotaOverride < 0 {
			fail(w, 400, "invalid expiry or quota")
			return
		}
		if e := h.s.PutEntitlement(v); e != nil {
			storeError(w, e)
			return
		}
		h.s.Audit(current(r).Account.ID, "entitlement.saved", id)
		writeJSON(w, 200, v)
	})
	r.Post("/users/{id}/reset", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Reason string `json:"reason"`
		}
		if !decode(w, r, &in) {
			return
		}
		id := chi.URLParam(r, "id")
		if e := h.s.ManualReset(id, in.Reason, time.Now().UTC()); e != nil {
			storeError(w, e)
			return
		}
		h.s.Audit(current(r).Account.ID, "usage.reset", id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	r.Get("/audit", func(w http.ResponseWriter, r *http.Request) { h.listGlobal(w, "audit") })
}
func (h *server) listGlobal(w http.ResponseWriter, kind string) {
	v, e := h.s.List(kind)
	if e != nil {
		fail(w, 500, "cannot list records")
		return
	}
	writeJSON(w, 200, v)
}

type Overview struct {
	EffectivePolicy   service.EffectivePolicy `json:"effectivePolicy"`
	AccountingPending bool                    `json:"accountingPending"`
	User              domain.User             `json:"user"`
	Entitlement       service.Entitlement     `json:"entitlement"`
	Service           *service.Plan           `json:"service,omitempty"`
	Usage             service.UsageTotals     `json:"usage"`
	Cycle             service.CycleWindow     `json:"cycle"`
	Status            string                  `json:"status"`
	QuotaBytes        int64                   `json:"quotaBytes"`
	RemainingBytes    *int64                  `json:"remainingBytes"`
	Routes            []OverviewRoute         `json:"routes"`
}
type OverviewRoute struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	RateMicros int64  `json:"rateMicros"`
}

func (h *server) overview(id string, now time.Time) (Overview, error) {
	v := Overview{Routes: []OverviewRoute{}, Status: "active"}
	if e := h.s.Get("users", id, &v.User); e != nil {
		return v, e
	}
	policy, e := h.s.EffectivePolicy(id, now)
	if e != nil {
		return v, e
	}
	v.EffectivePolicy = policy
	v.Entitlement = policy.Entitlement
	v.Service = policy.Service
	v.QuotaBytes = policy.QuotaBytes
	v.Status = policy.Status
	authorized := map[string]bool{}
	for _, routeID := range policy.RouteIDs {
		authorized[routeID] = true
	}
	v.Cycle, e = v.Entitlement.Cycle.Window(now)
	if e != nil {
		return v, e
	}
	v.Cycle.Start, e = h.s.LastReset(id, v.Cycle.Start, now)
	if e != nil {
		return v, e
	}
	v.Usage, e = h.s.Usage(id, v.Cycle.Start, now.Add(time.Nanosecond))
	if e != nil {
		return v, e
	}
	if v.QuotaBytes > 0 {
		remaining := v.QuotaBytes - v.Usage.WeightedBytes
		if remaining < 0 {
			remaining = 0
		}
		v.RemainingBytes = &remaining
	}
	if v.Status == "active" && v.QuotaBytes > 0 && v.Usage.WeightedBytes >= v.QuotaBytes {
		v.Status = "exhausted"
	}
	v.AccountingPending, e = h.s.HasAccountingHold(id)
	if e != nil {
		return v, e
	}
	if v.Status == "active" && v.AccountingPending {
		v.Status = "accounting-pending"
	}
	st, e := h.s.State()
	if e != nil {
		return v, e
	}
	rates, e := h.s.Rates()
	if e != nil {
		return v, e
	}
	for _, r := range st.Routes {
		assigned := authorized[r.ID]
		if !assigned {
			continue
		}
		rate := service.Rate{Micros: service.RateScale}
		for _, x := range rates {
			if x.RouteID == r.ID && !x.EffectiveAt.After(now) && x.EffectiveAt.After(rate.EffectiveAt) {
				rate = x
			}
		}
		v.Routes = append(v.Routes, OverviewRoute{ID: r.ID, Name: r.Name, RateMicros: rate.Micros, Kind: "legacy-client-chain"})
	}
	managed, e := h.s.List("published-routes")
	if e != nil {
		return v, e
	}
	for _, raw := range managed {
		var route domain.PublishedRoute
		if e = json.Unmarshal(raw, &route); e != nil {
			return v, e
		}
		if !authorized[route.ID] {
			continue
		}
		rate := service.Rate{Micros: service.RateScale}
		for _, x := range rates {
			if x.RouteID == route.ID && !x.EffectiveAt.After(now) && x.EffectiveAt.After(rate.EffectiveAt) {
				rate = x
			}
		}
		v.Routes = append(v.Routes, OverviewRoute{ID: route.ID, Name: route.Name, RateMicros: rate.Micros, Kind: "managed-server-path"})
	}
	return v, nil
}

var _ = json.Valid
