package httpapi_test

import (
	"encoding/json"
	"net/http"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"testing"
)

func readGroupEditContext(t *testing.T, client *http.Client, base, id string) service.PolicyEditContext {
	t.Helper()
	code, _, raw := req(t, client, "GET", base+"/api/access-policy/edit-context/group/"+id, "", nil)
	if code != 200 {
		t.Fatalf("group context: %d %s", code, raw)
	}
	var context service.PolicyEditContext
	if err := json.Unmarshal([]byte(raw), &context); err != nil {
		t.Fatal(err)
	}
	return context
}

func TestGroupEditHTTPRejectsStaleOpeningAndPreservesConcurrentMembership(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	for _, id := range []string{"u1", "u2"} {
		if err := s.PutUser(domain.User{ID: id, Name: "Same name", Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	plan := service.Plan{ID: "plan", Name: "Plan", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/services", "", plan); code != 200 {
		t.Fatalf("plan: %d %s", code, raw)
	}
	initial := service.PolicyChange{Group: &service.Group{ID: "group", Name: "Members", ServiceID: "plan", Priority: 5, MemberIDs: []string{"u1"}}}
	code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", initial)
	if code != 200 {
		t.Fatalf("setup preview: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": initial, "revision": p["revision"]}); code != 200 {
		t.Fatalf("setup apply: %d %s", code, raw)
	}
	a := readGroupEditContext(t, admin, srv.URL, "group")
	b := readGroupEditContext(t, admin, srv.URL, "group")
	b.Record.Group.MemberIDs = []string{"u2", "u1", "u2"}
	code, p, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": b.Record, "precondition": b.Precondition})
	if code != 200 || p["guard"] != "opened-record" {
		t.Fatalf("second editor preview: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": b.Record, "revision": p["revision"]}); code != 200 {
		t.Fatalf("second editor apply: %d %s", code, raw)
	}
	a.Record.Group.Name = "Renamed"
	code, rejected, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": a.Record, "precondition": a.Precondition})
	if code != 409 || rejected["code"] != "POLICY_EDIT_BASELINE_CHANGED" || rejected["detail"] != "用户组已更新。当前草稿尚未保存，请查看最新版本。" || rejected["revision"] != nil {
		t.Fatalf("stale rename received ticket: %d %s", code, raw)
	}
	fresh := readGroupEditContext(t, admin, srv.URL, "group")
	if fresh.Record.Group.Name != "Members" || !reflect.DeepEqual(fresh.Record.Group.MemberIDs, []string{"u1", "u2"}) {
		t.Fatalf("old draft changed record: %+v", fresh)
	}
	fresh.Record.Group.Name = "Renamed"
	code, p, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": fresh.Record, "precondition": fresh.Precondition})
	var reviewed service.PolicyPreview
	if code != 200 || json.Unmarshal([]byte(raw), &reviewed) != nil || reviewed.Resource == nil || reviewed.Resource.Before == nil || reviewed.Resource.Before.Group == nil || reviewed.Resource.After.Group == nil {
		t.Fatalf("resource shape: %d %s", code, raw)
	}
	if reviewed.Resource.Target != (service.PolicyResourceTarget{Kind: "group", ID: "group"}) || reviewed.Resource.Before.Group.Name != "Members" || reviewed.Resource.After.Group.Name != "Renamed" || !reflect.DeepEqual(reviewed.Resource.After.Group.MemberIDs, []string{"u1", "u2"}) || len(reviewed.Affected) != 0 {
		t.Fatalf("group review hid zero-impact resource change: %+v", reviewed)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": fresh.Record, "revision": p["revision"]}); code != 200 {
		t.Fatalf("reconciled apply: %d %s", code, raw)
	}
	code, _, raw = req(t, admin, "GET", srv.URL+"/api/user-groups", "", nil)
	var rows []map[string]any
	if code != 200 || json.Unmarshal([]byte(raw), &rows) != nil || len(rows) != 1 || rows[0]["name"] != "Renamed" {
		t.Fatalf("saved group: %d %s", code, raw)
	}
	for _, key := range []string{"precondition", "revision", "guard", "target", "resource"} {
		if _, exists := rows[0][key]; exists {
			t.Fatalf("transport metadata persisted: %s", key)
		}
	}
}

func TestGroupEditHTTPEnvelopeRequiresGuardAndKeepsRawEntitlementCompatible(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	if err := s.PutServicePlan(service.Plan{ID: "plan", Name: "Plan", Cycle: service.CyclePolicy{Mode: "none"}}); err != nil {
		t.Fatal(err)
	}
	opened := readGroupEditContext(t, admin, srv.URL, "new-group")
	change := service.PolicyChange{Group: &service.Group{ID: "new-group", Name: "Empty", ServiceID: "plan", MemberIDs: []string{}}}
	for _, test := range []struct {
		name   string
		body   any
		status int
	}{
		{"missing precondition", map[string]any{"change": change}, 428},
		{"null precondition", map[string]any{"change": change, "precondition": nil}, 428},
		{"missing presence", map[string]any{"change": change, "precondition": map[string]any{"revision": opened.Precondition.Revision}}, 428},
		{"empty token", map[string]any{"change": change, "precondition": map[string]any{"exists": false}}, 428},
		{"wrong presence", map[string]any{"change": change, "precondition": service.PolicyEditPrecondition{Exists: true, Revision: opened.Precondition.Revision}}, 409},
		{"mixed shape", map[string]any{"change": change, "precondition": opened.Precondition, "group": change.Group}, 400},
		{"multiple targets", map[string]any{"change": service.PolicyChange{Group: change.Group, Service: &service.Plan{ID: "plan"}}, "precondition": opened.Precondition}, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", test.body)
			if code != test.status || p["revision"] != nil {
				t.Fatalf("guard failure downgraded: %d %s", code, raw)
			}
		})
	}
	code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": change, "precondition": opened.Precondition})
	if code != 200 || p["guard"] != "opened-record" || p["resource"].(map[string]any)["before"] != nil {
		t.Fatalf("explicit absent group create: %d %s", code, raw)
	}
	if code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", change); code != 200 || p["guard"] != nil {
		t.Fatalf("intentional raw replacement compatibility: %d %s", code, raw)
	}
	if err := s.PutUser(domain.User{ID: "subject", Name: "Subject", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	entitlement := service.PolicyChange{Entitlement: &service.Entitlement{UserID: "subject", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}}
	if code, body, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": entitlement, "precondition": opened.Precondition}); code != 409 || body["code"] != "POLICY_EDIT_BASELINE_CHANGED" {
		t.Fatalf("group token transplanted to entitlement: %d %s", code, raw)
	}
	if code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", entitlement); code != 200 || p["guard"] != nil || p["resource"] != nil {
		t.Fatalf("legacy entitlement changed contract: %d %s", code, raw)
	}
}

func TestGroupEditHTTPKeepsAdminAuthorityNoStoreAndStrictStoredShape(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "group-editor-user")
	opened := readGroupEditContext(t, admin, srv.URL, "new-group")
	change := service.PolicyChange{Group: &service.Group{ID: "new-group", Name: "New", ServiceID: "plan"}}
	for _, client := range []struct {
		client *http.Client
		csrf   string
		status int
	}{{http.DefaultClient, "", 401}, {user.c, user.csrf, 403}} {
		if code, _, raw := req(t, client.client, "GET", srv.URL+"/api/access-policy/edit-context/group/new-group", "", nil); code != client.status {
			t.Fatalf("context authority: %d %s", code, raw)
		}
		if code, _, raw := req(t, client.client, "POST", srv.URL+"/api/access-policy/preview", client.csrf, map[string]any{"change": change, "precondition": opened.Precondition}); code != client.status {
			t.Fatalf("preview authority: %d %s", code, raw)
		}
	}
	response, err := admin.Get(srv.URL + "/api/access-policy/edit-context/group/new-group")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("group edit context may be cached")
	}
	if err := s.Put("user-groups", "new-group", map[string]any{"id": "new-group", "name": "New", "serviceId": "plan", "memberIds": []string{}, "futureRule": true}); err != nil {
		t.Fatal(err)
	}
	if code, p, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/group/new-group", "", nil); code != 422 || p["code"] != "POLICY_EDIT_UNSUPPORTED_RECORD" {
		t.Fatalf("unknown stored group field discarded: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/entitlement/missing-subject", "", nil); code != 404 {
		t.Fatalf("missing entitlement subject was synthesized: %d %s", code, raw)
	}
}

func TestGroupEditHTTPReferenceLabelsAreAdditiveTransportOnly(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	if err := s.PutUser(domain.User{ID: "u1", Name: "Alice", Enabled: true, UsedBytes: 7}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutServicePlan(service.Plan{ID: "plan", Name: "Plan", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
		t.Fatal(err)
	}
	opened := readGroupEditContext(t, admin, srv.URL, "new-group")
	empty := service.PolicyReferenceLabels{Users: []service.PolicyReferenceLabel{}, Services: []service.PolicyReferenceLabel{}}
	if opened.References == nil || !reflect.DeepEqual(*opened.References, empty) {
		t.Fatalf("absent context reference shape: %+v", opened.References)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "new-group", Name: "Members", ServiceID: "plan", MemberIDs: []string{"u1"}}}
	code, body, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": change, "precondition": opened.Precondition})
	var preview service.PolicyPreview
	if code != 200 || json.Unmarshal([]byte(raw), &preview) != nil || preview.Resource == nil || preview.Resource.References == nil {
		t.Fatalf("guarded display review: %d %s", code, raw)
	}
	want := service.PolicyReferenceLabels{Users: []service.PolicyReferenceLabel{{ID: "u1", Name: "Alice"}}, Services: []service.PolicyReferenceLabel{{ID: "plan", Name: "Plan"}}}
	if !reflect.DeepEqual(preview.Resource.References.Before, empty) || !reflect.DeepEqual(preview.Resource.References.After, want) {
		t.Fatalf("reference sides do not match create: %+v", preview.Resource.References)
	}
	refs := body["resource"].(map[string]any)["references"].(map[string]any)["after"].(map[string]any)
	for _, kind := range []string{"users", "services"} {
		label := refs[kind].([]any)[0].(map[string]any)
		if len(label) != 2 || label["id"] == nil || label["name"] == nil {
			t.Fatalf("reference metadata includes non-display fields: %+v", label)
		}
	}
	// An additive-response-tolerant old client does not need labels in either
	// its decoded preview shape or its unchanged apply payload.
	var oldClient struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal([]byte(raw), &oldClient); err != nil || oldClient.Revision == "" {
		t.Fatalf("old response decoder: %+v %v", oldClient, err)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": change, "revision": oldClient.Revision}); code != 200 {
		t.Fatalf("label-free apply payload rejected: %d %s", code, raw)
	}
	context := readGroupEditContext(t, admin, srv.URL, "new-group")
	if context.References == nil || !reflect.DeepEqual(*context.References, want) {
		t.Fatalf("saved context labels: %+v", context.References)
	}
	code, _, raw = req(t, admin, "GET", srv.URL+"/api/user-groups", "", nil)
	var rows []map[string]any
	if code != 200 || json.Unmarshal([]byte(raw), &rows) != nil || len(rows) != 1 || len(rows[0]) != 5 || rows[0]["references"] != nil {
		t.Fatalf("display metadata persisted in group: %d %s", code, raw)
	}
	if code, body, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/service/plan", "", nil); code != 200 || body["references"] != nil {
		t.Fatalf("service display scope changed: %d %s", code, raw)
	}
	if code, body, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", change); code != 200 || body["guard"] != nil || body["resource"] == nil {
		t.Fatalf("explicit raw replacement compatibility changed: %d %s", code, raw)
	}
}
