package httpapi_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"strings"
	"testing"
	"time"
)

func TestAccessPolicyHTTPPreviewApplyAndTenantIsolation(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	alice := inviteClient(t, s, srv, "group-alice")
	bob := inviteClient(t, s, srv, "group-bob")
	if e := s.Put("routes", "r1", domain.Route{ID: "r1", Name: "First"}); e != nil {
		t.Fatal(e)
	}
	plan := service.Plan{ID: "p1", Name: "Group plan", QuotaBytes: 1000, RouteIDs: []string{"r1"}, ConnectionLimit: 3, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	if status, _, raw := req(t, admin, "POST", srv.URL+"/api/services", "", plan); status != 200 {
		t.Fatalf("plan: %d %s", status, raw)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "group", Name: "Members", ServiceID: plan.ID, Priority: 10, MemberIDs: []string{alice.id}}}
	status, preview, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", change)
	if status != 200 || len(preview["affected"].([]any)) != 1 {
		t.Fatalf("preview: %d %s", status, raw)
	}
	if status, _, raw = req(t, alice.c, "POST", srv.URL+"/api/access-policy/apply", alice.csrf, map[string]any{"change": change, "revision": preview["revision"]}); status != 403 {
		t.Fatalf("tenant policy write: %d %s", status, raw)
	}
	if status, _, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": change, "revision": preview["revision"]}); status != 200 {
		t.Fatalf("apply: %d %s", status, raw)
	}
	if status, _, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": change, "revision": preview["revision"]}); status != 409 {
		t.Fatalf("stale: %d %s", status, raw)
	}
	status, overview, raw := req(t, alice.c, "GET", srv.URL+"/api/me/overview", "", nil)
	effective := overview["effectivePolicy"].(map[string]any)
	if status != 200 || effective["serviceId"] != "p1" || effective["connectionLimit"] != float64(3) || len(overview["routes"].([]any)) != 1 {
		t.Fatalf("group overview %d %s", status, raw)
	}
	if status, _, raw = req(t, bob.c, "GET", srv.URL+"/api/users/"+alice.id+"/effective-policy", "", nil); status != 403 {
		t.Fatalf("cross-account policy disclosure: %d %s", status, raw)
	}
	if status, _, raw = req(t, bob.c, "GET", srv.URL+"/api/user-groups", "", nil); status != 403 {
		t.Fatalf("group directory disclosure: %d %s", status, raw)
	}
	// Exact route override must remove legacy route grants as well as group routes.
	if e := s.Put("routes", "r1", domain.Route{ID: "r1", Name: "First", UserIDs: []string{alice.id}}); e != nil {
		t.Fatal(e)
	}
	var ent service.Entitlement
	b, _ := json.Marshal(overview["entitlement"])
	json.Unmarshal(b, &ent)
	empty := []string{}
	ent.RouteIDsOverride = &empty
	limit := 1
	ent.ConnectionLimitOverride = &limit
	if status, _, raw = req(t, admin, "PUT", srv.URL+"/api/users/"+alice.id+"/entitlement", "", ent); status != 200 {
		t.Fatalf("individual override: %d %s", status, raw)
	}
	status, overview, raw = req(t, alice.c, "GET", srv.URL+"/api/me/overview", "", nil)
	if status != 200 || len(overview["routes"].([]any)) != 0 || overview["effectivePolicy"].(map[string]any)["connectionLimit"] != float64(1) {
		t.Fatalf("exact override ignored %d %s", status, raw)
	}
	ent.Paused = true
	if status, _, raw = req(t, admin, "PUT", srv.URL+"/api/users/"+alice.id+"/entitlement", "", ent); status != 200 {
		t.Fatalf("pause: %d %s", status, raw)
	}
	status, overview, raw = req(t, alice.c, "GET", srv.URL+"/api/me/overview", "", nil)
	if status != 200 || overview["status"] != "paused" {
		t.Fatalf("pause hidden %d %s", status, raw)
	}
}

func TestAccessPolicyPreviewRejectsUnknownReferencesAndShowsAmbiguity(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	alice := inviteClient(t, s, srv, "ambiguous-alice")
	for _, id := range []string{"one", "two"} {
		if e := s.PutServicePlan(service.Plan{ID: id, Name: id, Cycle: service.CyclePolicy{Mode: "none"}}); e != nil {
			t.Fatal(e)
		}
	}
	group := service.Group{ID: "one", Name: "One", ServiceID: "one", MemberIDs: []string{alice.id}}
	change := service.PolicyChange{Group: &group}
	preview, e := s.PreviewPolicyChange(change, time.Now().UTC())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, time.Now().UTC()); e != nil {
		t.Fatal(e)
	}
	group.ID = "two"
	group.ServiceID = "two"
	status, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", service.PolicyChange{Group: &group})
	if status != 200 || len(p["blockers"].([]any)) != 1 || !strings.Contains(raw, "ambiguous") {
		t.Fatalf("ambiguous result %d %s", status, raw)
	}
	if status, _, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": service.PolicyChange{Group: &group}, "revision": p["revision"]}); status == 200 {
		t.Fatalf("ambiguous applied: %s", raw)
	}
	group.MemberIDs = []string{"missing"}
	if status, _, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", service.PolicyChange{Group: &group}); status == 200 {
		t.Fatalf("unknown member accepted %s", raw)
	}
}
