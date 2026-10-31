package httpapi_test

import (
	"encoding/json"
	"net/http"
	"routeweaver/internal/service"
	"testing"
	"time"
)

// Each call is an explicit editor read. This helper never refreshes or retries
// a failed mutation, and does not attach a new baseline to an old draft.
func readServiceEditContext(t *testing.T, client *http.Client, base, id string) service.PolicyEditContext {
	t.Helper()
	code, value, raw := req(t, client, "GET", base+"/api/access-policy/edit-context/service/"+id, "", nil)
	if code != 200 {
		t.Fatalf("edit context: %d %s", code, raw)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var context service.PolicyEditContext
	if err := json.Unmarshal(encoded, &context); err != nil {
		t.Fatal(err)
	}
	return context
}

func TestServiceEditHTTPRejectsStaleOpeningAndReviewsReconciledDefaults(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	plan := service.Plan{ID: "plan", Name: "Standard", QuotaBytes: 50, RouteIDs: []string{}, Cycle: service.CyclePolicy{Mode: "monthly", Day: 1, Anchor: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Timezone: "UTC+8"}}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/services", "", plan); code != 200 {
		t.Fatalf("create: %d %s", code, raw)
	}
	a := readServiceEditContext(t, admin, srv.URL, plan.ID)
	b := readServiceEditContext(t, admin, srv.URL, plan.ID)
	b.Record.Service.Cycle.Day = 15
	code, review, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": b.Record, "precondition": b.Precondition})
	if code != 200 || review["guard"] != "opened-record" || review["resource"] == nil {
		t.Fatalf("guarded review: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": b.Record, "revision": review["revision"]}); code != 200 {
		t.Fatalf("second editor apply: %d %s", code, raw)
	}
	a.Record.Service.QuotaBytes = 100
	code, rejected, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": a.Record, "precondition": a.Precondition})
	if code != 409 || rejected["code"] != "POLICY_EDIT_BASELINE_CHANGED" || rejected["detail"] != "服务方案已更新。当前草稿尚未保存，请查看最新版本。" || rejected["revision"] != nil {
		t.Fatalf("stale draft blessed with fresh ticket: %d %s", code, raw)
	}
	fresh := readServiceEditContext(t, admin, srv.URL, plan.ID)
	if fresh.Record.Service.Cycle.Day != 15 || fresh.Record.Service.QuotaBytes != 50 {
		t.Fatalf("stale edit leaked: %+v", fresh)
	}
	fresh.Record.Service.QuotaBytes = 100
	code, review, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": fresh.Record, "precondition": fresh.Precondition})
	if code != 200 {
		t.Fatalf("reconciled preview: %d %s", code, raw)
	}
	var typed service.PolicyPreview
	if err := json.Unmarshal([]byte(raw), &typed); err != nil {
		t.Fatal(err)
	}
	if typed.Resource == nil || typed.Resource.Before == nil || typed.Resource.Before.Service.Cycle.Day != 15 || typed.Resource.After.Service.Cycle.Day != 15 || typed.Resource.After.Service.QuotaBytes != 100 || len(typed.Affected) != 0 {
		t.Fatalf("zero-user review omitted authoritative defaults: %+v", typed)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": fresh.Record, "revision": review["revision"]}); code != 200 {
		t.Fatalf("reconciled apply: %d %s", code, raw)
	}
	// Public context metadata is never part of the persisted service record.
	code, _, raw = req(t, admin, "GET", srv.URL+"/api/services", "", nil)
	var records []map[string]any
	if code != 200 || json.Unmarshal([]byte(raw), &records) != nil || len(records) != 1 {
		t.Fatalf("service list: %d %s", code, raw)
	}
	for _, key := range []string{"precondition", "revision", "guard", "target", "resource"} {
		if _, exists := records[0][key]; exists {
			t.Fatalf("transport metadata persisted: %s", key)
		}
	}
}

func TestServiceEditHTTPGuardedEnvelopeCannotDowngradeToReplacement(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	opened := readServiceEditContext(t, admin, srv.URL, "new-plan")
	plan := service.Plan{ID: "new-plan", Name: "Standard", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	change := service.PolicyChange{Service: &plan}
	for _, test := range []struct {
		name   string
		body   any
		status int
	}{
		{"missing precondition", map[string]any{"change": change}, 428},
		{"null precondition", map[string]any{"change": change, "precondition": nil}, 428},
		{"empty token", map[string]any{"change": change, "precondition": map[string]any{"exists": false}}, 428},
		{"missing presence", map[string]any{"change": change, "precondition": map[string]any{"revision": opened.Precondition.Revision}}, 428},
		{"mixed envelope", map[string]any{"change": change, "precondition": opened.Precondition, "service": nil}, 400},
		{"unknown field", map[string]any{"change": change, "precondition": opened.Precondition, "ignored": true}, 400},
		{"wrong presence", map[string]any{"change": change, "precondition": service.PolicyEditPrecondition{Exists: true, Revision: opened.Precondition.Revision}}, 409},
	} {
		t.Run(test.name, func(t *testing.T) {
			code, response, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", test.body)
			if code != test.status || response["revision"] != nil {
				t.Fatalf("guard failure produced a review: %d %s", code, raw)
			}
		})
	}
	code, review, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": change, "precondition": opened.Precondition})
	if code != 200 || review["guard"] != "opened-record" {
		t.Fatalf("absent guarded create: %d %s", code, raw)
	}
	resource := review["resource"].(map[string]any)
	if resource["before"] != nil {
		t.Fatalf("absent baseline invented a saved record: %s", raw)
	}
	// The raw, intentional replacement contract remains distinct and usable.
	code, legacy, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", change)
	if code != 200 || legacy["guard"] != nil {
		t.Fatalf("legacy contract silently relabeled: %d %s", code, raw)
	}
}

func TestServiceEditHTTPContextAndPreviewKeepAdminAuthority(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "policy-edit-user")
	admin := operatorClient()
	opened := readServiceEditContext(t, admin, srv.URL, "new-plan")
	for _, client := range []struct {
		client *http.Client
		csrf   string
		status int
	}{{http.DefaultClient, "", 401}, {user.c, user.csrf, 403}} {
		if code, _, raw := req(t, client.client, "GET", srv.URL+"/api/access-policy/edit-context/service/new-plan", "", nil); code != client.status {
			t.Fatalf("edit-context authority: %d %s", code, raw)
		}
		body := map[string]any{"change": service.PolicyChange{Service: &service.Plan{ID: "new-plan", Name: "Plan", Cycle: service.CyclePolicy{Mode: "none"}}}, "precondition": opened.Precondition}
		if code, _, raw := req(t, client.client, "POST", srv.URL+"/api/access-policy/preview", client.csrf, body); code != client.status {
			t.Fatalf("preview authority: %d %s", code, raw)
		}
	}
	response, err := admin.Get(srv.URL + "/api/access-policy/edit-context/service/new-plan")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("edit context can be reused by an HTTP cache")
	}
}
