package service_test

import (
	"routeweaver/internal/service"
	"testing"
	"time"
)

func TestEffectiveAccessSelectsOneGroupAndIndividualOverrides(t *testing.T) {
	now := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
	input := service.PolicyInput{UserID: "u", Enabled: true, Entitlement: service.Entitlement{UserID: "u", Cycle: service.CyclePolicy{Mode: "none"}}, Plans: []service.Plan{{ID: "basic", QuotaBytes: 100, RouteIDs: []string{"r1"}, ConnectionLimit: 2}, {ID: "premium", QuotaBytes: 200, RouteIDs: []string{"r2"}, ConnectionLimit: 4}}, Groups: []service.Group{{ID: "g1", ServiceID: "basic", Priority: 1, MemberIDs: []string{"u"}}, {ID: "g2", ServiceID: "premium", Priority: 2, MemberIDs: []string{"u"}}}}
	got := service.ResolvePolicy(input, now)
	if got.ServiceID != "premium" || got.QuotaBytes != 200 || len(got.RouteIDs) != 1 || got.RouteIDs[0] != "r2" || got.ConnectionLimit != 4 {
		t.Fatalf("group policy: %+v", got)
	}
	input.Groups[0].Priority = 2
	got = service.ResolvePolicy(input, now)
	if got.Status != "ambiguous" || len(got.RouteIDs) != 0 {
		t.Fatalf("tie escalated: %+v", got)
	}
	input.Entitlement.ServiceID = "basic"
	quota := int64(50)
	limit := 1
	routes := []string{"r3"}
	input.Entitlement.QuotaOverride = &quota
	input.Entitlement.ConnectionLimitOverride = &limit
	input.Entitlement.RouteIDsOverride = &routes
	got = service.ResolvePolicy(input, now)
	if got.Status != "active" || got.ServiceID != "basic" || got.QuotaBytes != 50 || got.ConnectionLimit != 1 || len(got.RouteIDs) != 1 || got.RouteIDs[0] != "r3" || got.Provenance["service"] != "individual" || got.Provenance["connectionLimit"] != "individual" {
		t.Fatalf("override: %+v", got)
	}
}

func TestEffectiveAccessSameServiceTiesDoNotStackAndOverridesCanDenyAll(t *testing.T) {
	now := time.Now().UTC()
	input := service.PolicyInput{UserID: "u", Enabled: true, QuotaBytes: 50, Entitlement: service.Entitlement{UserID: "u", Cycle: service.CyclePolicy{Mode: "none"}}, Plans: []service.Plan{{ID: "p", QuotaBytes: 100, RouteIDs: []string{"service-route"}, OnlineIPLimit: 2, EntryRateBPS: 1000}}, Groups: []service.Group{{ID: "a", ServiceID: "p", MemberIDs: []string{"u"}}, {ID: "b", ServiceID: "p", MemberIDs: []string{"u"}}}, DirectRouteIDs: []string{"direct-route"}}
	got := service.ResolvePolicy(input, now)
	if got.Status != "active" || got.QuotaBytes != 100 || len(got.RouteIDs) != 2 || len(got.GroupIDs) != 2 {
		t.Fatalf("same service groups stacked %+v", got)
	}
	empty := []string{}
	zero := 0
	rate := int64(80)
	input.Entitlement.RouteIDsOverride = &empty
	input.Entitlement.OnlineIPLimitOverride = &zero
	input.Entitlement.EntryRateBPSOverride = &rate
	got = service.ResolvePolicy(input, now)
	if len(got.RouteIDs) != 0 || got.OnlineIPLimit != 0 || got.EntryRateBPS != 80 || got.AllowsRoute("direct-route") {
		t.Fatalf("exact overrides %+v", got)
	}
	for _, status := range []string{"paused", "not-started", "expired", "disabled"} {
		in := input
		switch status {
		case "paused":
			in.Entitlement.Paused = true
		case "not-started":
			in.Entitlement.StartsAt = now.Add(time.Hour)
		case "expired":
			end := now.Add(-time.Hour)
			in.Entitlement.ExpiresAt = &end
		case "disabled":
			in.Enabled = false
		}
		got = service.ResolvePolicy(in, now)
		if got.Status != status {
			t.Fatalf("want %s: %+v", status, got)
		}
	}
}
