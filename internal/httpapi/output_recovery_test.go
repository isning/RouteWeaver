package httpapi_test

import (
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestOutputStatusExplainsRepairableMissingReferenceWithoutChangingPublications(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "repair-owner")
	other := inviteClient(t, s, srv, "repair-other")
	p := templateTestProfile("repair-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	before := map[string]httpapi.Output{}
	for _, id := range []string{"macbook", "android"} {
		code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]string{"id": id, "name": id, "profileId": p.ID})
		if code != 201 {
			t.Fatal(raw)
		}
		var output httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &output); err != nil {
			t.Fatal(err)
		}
		before[id] = output
	}
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed-private-id"}
	code, _, raw = putCurrentProfileDraft(t, owner, srv.URL+"/api/me/profiles/"+p.ID, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	want := map[string]any{"state": "unavailable", "reason": "missing-action-reference", "location": "default"}
	if code != 200 || !reflect.DeepEqual(status["draftComparison"], want) {
		t.Fatalf("missing actionable safe status: %d %s", code, raw)
	}
	for _, secret := range []string{"removed-private-id", "secret-password", "private-user", "endpoint reference missing", "feedPath", "tokenDigest", "validation"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("status leaked %s: %s", secret, raw)
		}
	}
	for id, expected := range before {
		var actual httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("status changed complete %s publication", id)
		}
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || strings.Contains(raw, "draftComparison") || strings.Contains(raw, "missing-action-reference") {
		t.Fatalf("ordinary list contract changed: %d %s", code, raw)
	}
	code, _, raw = req(t, other.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	if code != 404 || strings.Contains(raw, "missing-action-reference") {
		t.Fatalf("cross-tenant recovery disclosure: %d %s", code, raw)
	}
	// Repairing the shared draft and reviewing one target are not publication.
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "node"}
	code, _, raw = putCurrentProfileDraft(t, owner, srv.URL+"/api/me/profiles/"+p.ID, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, preview, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", owner.csrf, map[string]string{"outputId": "macbook"})
	if code != 200 {
		t.Fatal(raw)
	}
	for id, expected := range before {
		var actual httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("repair/review changed complete %s publication", id)
		}
	}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs/macbook/publish", owner.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	for id, expected := range before {
		var actual httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &actual); err != nil {
			t.Fatal(err)
		}
		if id == "android" && !reflect.DeepEqual(actual, expected) {
			t.Fatal("publishing MacBook changed complete Android record")
		}
		if id == "macbook" && reflect.DeepEqual(actual, expected) {
			t.Fatal("explicit reviewed MacBook publication had no effect")
		}
	}

}

func TestOutputStatusOnlyClassifiesTypedRepairLocations(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		mutate   func(*httpapi.Profile)
		location string
	}{
		{"group", func(p *httpapi.Profile) {
			p.IR.Groups = []domain.PolicyGroup{{ID: "group", Name: "Choice", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "removed"}}}}
		}, "group"},
		{"rule", func(p *httpapi.Profile) {
			p.IR.Rules = []domain.PolicyRule{{ID: "rule", Match: domain.MatchExpression{Op: "domain", Value: "private.invalid"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed"}}}
		}, "rule"},
		{"unknown action", func(p *httpapi.Profile) { p.IR.DefaultAction = domain.ActionRef{Kind: "other", Ref: "removed"} }, ""},
		{"malformed reference", func(p *httpapi.Profile) {
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "private/invalid"}
		}, ""},
		{"renderer failure", func(p *httpapi.Profile) {
			p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: p.Target.AdapterID, Version: p.Target.Version}, Format: "json", RuleMode: "prepend", Content: `{"broken"`}
		}, ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "repair-owner")
			p := templateTestProfile("repair-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]string{"id": "repair-output", "name": "Repair", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			scenario.mutate(&p)
			code, _, raw = putCurrentProfileDraft(t, owner, srv.URL+"/api/me/profiles/"+p.ID, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, status, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/repair-output/status", "", nil)
			want := map[string]any{"state": "unavailable"}
			if scenario.location != "" {
				want["reason"] = "missing-action-reference"
				want["location"] = scenario.location
			}
			if code != 200 || !reflect.DeepEqual(status["draftComparison"], want) {
				t.Fatalf("unexpected classification: %d %s", code, raw)
			}
		})
	}
}
