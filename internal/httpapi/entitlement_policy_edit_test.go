package httpapi_test

import (
	"encoding/json"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func readEntitlementEditContext(t *testing.T, client *http.Client, base, id string) service.PolicyEditContext {
	t.Helper()
	code, _, raw := req(t, client, "GET", base+"/api/access-policy/edit-context/entitlement/"+id, "", nil)
	var context service.PolicyEditContext
	if code != 200 || json.Unmarshal([]byte(raw), &context) != nil {
		t.Fatalf("entitlement context: %d %s", code, raw)
	}
	return context
}

func TestEntitlementEditHTTPRejectsStaleOpeningAndKeepsLegacyConsumerShape(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	if err := s.PutUser(domain.User{ID: "subject", Name: "Subject", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	ent := service.Entitlement{UserID: "subject", Cycle: service.CyclePolicy{Mode: "monthly", Day: 1, Anchor: time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC), Timezone: "UTC+8"}}
	if err := s.PutEntitlement(ent); err != nil {
		t.Fatal(err)
	}
	a, b := readEntitlementEditContext(t, admin, srv.URL, "subject"), readEntitlementEditContext(t, admin, srv.URL, "subject")
	if a.Effective == nil || a.Effective.UserID != "subject" || a.Record.Entitlement.Cycle.Day != 1 || a.Effective.Entitlement.Cycle.Day != 1 {
		t.Fatalf("context is not coherent: %+v", a)
	}
	b.Record.Entitlement.Cycle.Day = 15
	code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": b.Record, "precondition": b.Precondition})
	if code != 200 || p["guard"] != "opened-record" || p["resource"] == nil {
		t.Fatalf("B guarded preview: %d %s", code, raw)
	}
	if code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": b.Record, "revision": p["revision"]}); code != 200 || p["resource"] != nil || p["guard"] != nil {
		t.Fatalf("apply contract changed: %d %s", code, raw)
	}
	quota := int64(100)
	a.Record.Entitlement.QuotaOverride = &quota
	code, p, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": a.Record, "precondition": a.Precondition})
	if code != 409 || p["code"] != "POLICY_EDIT_BASELINE_CHANGED" || p["detail"] != "个人授权已更新。当前草稿尚未保存，请查看最新版本。" || p["revision"] != nil {
		t.Fatalf("stale full draft not rejected: %d %s", code, raw)
	}
	fresh := readEntitlementEditContext(t, admin, srv.URL, "subject")
	fresh.Record.Entitlement.QuotaOverride = &quota
	code, _, raw = req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": fresh.Record, "precondition": fresh.Precondition})
	var preview service.PolicyPreview
	if code != 200 || json.Unmarshal([]byte(raw), &preview) != nil || preview.Resource == nil || preview.Resource.Target != (service.PolicyResourceTarget{Kind: "entitlement", ID: "subject"}) || preview.Resource.Before.Entitlement.Cycle.Day != 15 || preview.Resource.After.Entitlement.Cycle.Day != 15 || preview.Resource.After.Entitlement.Cycle.Anchor.Nanosecond() != 123456789 {
		t.Fatalf("authoritative resource shape: %d %s", code, raw)
	}
	if code, p, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", fresh.Record); code != 200 || p["resource"] != nil || p["guard"] != nil {
		t.Fatalf("legacy UI encountered new entitlement resource: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/apply", "", map[string]any{"change": fresh.Record, "revision": preview.Revision}); code != 200 {
		t.Fatalf("reconciled apply: %d %s", code, raw)
	}
	final := readEntitlementEditContext(t, admin, srv.URL, "subject")
	if final.Record.Entitlement.Cycle.Day != 15 || *final.Record.Entitlement.QuotaOverride != 100 {
		t.Fatalf("reconciled save lost current calendar: %+v", final)
	}
}

func TestEntitlementEditHTTPAbsenceAndEnvelopeCannotDowngrade(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	if err := s.PutUser(domain.User{ID: "subject", Name: "Subject", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	opened := readEntitlementEditContext(t, admin, srv.URL, "subject")
	if opened.Record != nil || opened.Precondition.Exists || opened.Effective == nil || !opened.Effective.Entitlement.StartsAt.IsZero() || opened.Effective.Entitlement.Cycle.Mode != "none" {
		t.Fatalf("absence conflated with form seed: %+v", opened)
	}
	change := service.PolicyChange{Entitlement: &opened.Effective.Entitlement}
	for _, test := range []struct {
		name   string
		body   any
		status int
	}{
		{"missing precondition", map[string]any{"change": change}, 428},
		{"null precondition", map[string]any{"change": change, "precondition": nil}, 428},
		{"missing presence", map[string]any{"change": change, "precondition": map[string]any{"revision": opened.Precondition.Revision}}, 428},
		{"wrong presence", map[string]any{"change": change, "precondition": service.PolicyEditPrecondition{Exists: true, Revision: opened.Precondition.Revision}}, 409},
		{"tampered token", map[string]any{"change": change, "precondition": service.PolicyEditPrecondition{Revision: "tampered"}}, 409},
		{"mixed envelope", map[string]any{"change": change, "precondition": opened.Precondition, "entitlement": change.Entitlement}, 400},
		{"multiple targets", map[string]any{"change": service.PolicyChange{Entitlement: change.Entitlement, Group: &service.Group{ID: "g"}}, "precondition": opened.Precondition}, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			code, body, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", test.body)
			if code != test.status || body["revision"] != nil {
				t.Fatalf("guard silently downgraded: %d %s", code, raw)
			}
		})
	}
	code, body, raw := req(t, admin, "POST", srv.URL+"/api/access-policy/preview", "", map[string]any{"change": change, "precondition": opened.Precondition})
	if code != 200 || body["guard"] != "opened-record" || body["resource"].(map[string]any)["before"] != nil {
		t.Fatalf("absent creation review: %d %s", code, raw)
	}
	again := readEntitlementEditContext(t, admin, srv.URL, "subject")
	if again.Record != nil || again.Precondition != opened.Precondition {
		t.Fatalf("read/preview created entitlement: %+v", again)
	}
}

func TestEntitlementEditHTTPKeepsAuthorityNoStoreAndStrictSubjectShape(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	ordinary := inviteClient(t, s, srv, "entitlement-editor-user")
	opened := readEntitlementEditContext(t, admin, srv.URL, ordinary.id)
	change := service.PolicyChange{Entitlement: &opened.Effective.Entitlement}
	for _, client := range []struct {
		client *http.Client
		csrf   string
		status int
	}{{http.DefaultClient, "", 401}, {ordinary.c, ordinary.csrf, 403}} {
		if code, _, raw := req(t, client.client, "GET", srv.URL+"/api/access-policy/edit-context/entitlement/"+ordinary.id, "", nil); code != client.status {
			t.Fatalf("context authority: %d %s", code, raw)
		}
		if code, _, raw := req(t, client.client, "POST", srv.URL+"/api/access-policy/preview", client.csrf, map[string]any{"change": change, "precondition": opened.Precondition}); code != client.status {
			t.Fatalf("preview authority: %d %s", code, raw)
		}
	}
	response, err := admin.Get(srv.URL + "/api/access-policy/edit-context/entitlement/" + ordinary.id)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("context may be cached")
	}
	if code, _, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/entitlement/missing-subject", "", nil); code != 404 {
		t.Fatalf("missing user synthesized: %d %s", code, raw)
	}
	if err := s.Put("entitlements", ordinary.id, map[string]any{"userId": ordinary.id, "futureRule": true}); err != nil {
		t.Fatal(err)
	}
	if code, body, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/entitlement/"+ordinary.id, "", nil); code != 422 || body["code"] != "POLICY_EDIT_UNSUPPORTED_RECORD" {
		t.Fatalf("unknown stored shape discarded: %d %s", code, raw)
	}
	// New explanatory context is entitlement-only; service/group DTOs stay lean.
	if code, body, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/service/absent-service", "", nil); code != 200 || body["effective"] != nil {
		t.Fatalf("service context contract changed: %d %s", code, raw)
	}
	if code, body, raw := req(t, admin, "GET", srv.URL+"/api/access-policy/edit-context/group/absent-group", "", nil); code != 200 || body["effective"] != nil {
		t.Fatalf("group context contract changed: %d %s", code, raw)
	}
}
