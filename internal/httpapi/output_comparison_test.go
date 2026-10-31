package httpapi_test

import (
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// The explicit workbench read reports a publication-versus-saved-input
// observation. It is not a private policy read, publication, or client receipt.
func TestOutputComparisonIsOwnerScopedCoarseAndReadOnly(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "comparison-owner")
	other := inviteClient(t, s, srv, "comparison-other")
	p := templateTestProfile("comparison-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Rules = []domain.PolicyRule{{ID: "private-rule", Match: domain.MatchExpression{Op: "domain-suffix", Value: "private-routing.invalid"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "node"}}}
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	before := map[string]httpapi.Output{}
	for _, id := range []string{"macbook", "android"} {
		target := p.Target
		if id == "android" {
			target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
		}
		code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": id, "name": id, "profileId": p.ID, "target": target})
		if code != 201 {
			t.Fatal(raw)
		}
		var output httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &output); err != nil {
			t.Fatal(err)
		}
		before[id] = output
	}
	read := func(id, want string) map[string]any {
		t.Helper()
		code, view, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/"+id+"/comparison", "", nil)
		if code != 200 {
			t.Fatalf("comparison read: %d %s", code, raw)
		}
		keys := []string{}
		for key := range view {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if !reflect.DeepEqual(keys, []string{"draftComparison", "id", "mode", "profileId", "revision", "status", "target"}) {
			t.Fatalf("coarse comparison fields changed: %v", keys)
		}
		if view["id"] != id || view["profileId"] != p.ID || view["revision"] != before[id].Revision || view["status"] != "published" || view["mode"] != string(before[id].Mode) {
			t.Fatalf("wrong publication identity: %s", raw)
		}
		if !reflect.DeepEqual(view["target"], map[string]any{"adapterId": before[id].Target.AdapterID, "version": before[id].Target.Version}) {
			t.Fatalf("wrong target: %s", raw)
		}
		if !reflect.DeepEqual(view["draftComparison"], map[string]any{"state": want}) {
			t.Fatalf("want %s: %s", want, raw)
		}
		for _, secret := range []string{"private-rule", "private-routing.invalid", "private-user", "secret-password", "routingIntent", "routingSummary", "artifacts", "downloadPath", "feedPath", "bundlePath", "tokenDigest", "connection", "resourceFiles"} {
			if strings.Contains(raw, secret) {
				t.Fatalf("coarse comparison leaked %q: %s", secret, raw)
			}
		}
		return view
	}
	read("macbook", "unchanged")
	read("android", "unchanged")
	p.IR.Endpoints[0].Connection.Password = "changed-private-password"
	code, _, raw = req(t, owner.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	read("macbook", "changed")
	read("android", "changed")
	for id, expected := range before {
		var actual httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &actual); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("comparison mutated complete %s publication", id)
		}
	}
	for _, scenario := range []struct {
		name   string
		client *http.Client
		id     string
		want   int
	}{
		{"foreign owner", other.c, "macbook", 404},
		{"missing output", owner.c, "missing", 404},
		{"unauthenticated", http.DefaultClient, "macbook", 401},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			code, _, raw := req(t, scenario.client, "GET", srv.URL+"/api/me/outputs/"+scenario.id+"/comparison", "", nil)
			if code != scenario.want || strings.Contains(raw, "draftComparison") || strings.Contains(raw, p.ID) {
				t.Fatalf("unauthorized comparison disclosure: %d %s", code, raw)
			}
		})
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || strings.Contains(raw, "draftComparison") || strings.Contains(raw, "private-routing.invalid") {
		t.Fatalf("ordinary inventory gained comparison/private detail: %d %s", code, raw)
	}
	// Only the existing selected review/publication changes its frozen Output.
	code, preview, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", owner.csrf, map[string]string{"outputId": "macbook"})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs/macbook/publish", owner.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	var updated httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "macbook", &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Revision == before["macbook"].Revision || updated.Token != before["macbook"].Token {
		t.Fatal("reviewed publication must change revision while retaining access identity")
	}
	before["macbook"] = updated
	read("macbook", "unchanged")
	read("android", "changed")
	var sibling httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "android", &sibling); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sibling, before["android"]) {
		t.Fatal("publishing MacBook or checking results changed the Android publication")
	}
}

func TestOutputComparisonPreservesTypedRepairAndUnknownStates(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		mutate   func(*httpapi.Profile)
		location string
	}{
		{"default", func(p *httpapi.Profile) {
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed-private-id"}
		}, "default"},
		{"group", func(p *httpapi.Profile) {
			p.IR.Groups = []domain.PolicyGroup{{ID: "group", Name: "Choice", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "removed-private-id"}}}}
		}, "group"},
		{"rule", func(p *httpapi.Profile) {
			p.IR.Rules = []domain.PolicyRule{{ID: "private-rule", Match: domain.MatchExpression{Op: "domain", Value: "private-routing.invalid"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed-private-id"}}}
		}, "rule"},
		{"unknown action", func(p *httpapi.Profile) {
			p.IR.DefaultAction = domain.ActionRef{Kind: "other", Ref: "removed-private-id"}
		}, ""},
		{"malformed reference", func(p *httpapi.Profile) {
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "private/invalid"}
		}, ""},
		{"renderer failure", func(p *httpapi.Profile) {
			p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: p.Target.AdapterID, Version: p.Target.Version}, Format: "json", RuleMode: "prepend", Content: `{"broken"`}
		}, ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "comparison-owner")
			p := templateTestProfile("comparison-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]string{"id": "comparison", "name": "Compare", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			var before httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "comparison", &before); err != nil {
				t.Fatal(err)
			}
			scenario.mutate(&p)
			code, _, raw = req(t, owner.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, owner.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			want := map[string]any{"state": "unavailable"}
			if scenario.location != "" {
				want["reason"] = "missing-action-reference"
				want["location"] = scenario.location
			}
			for _, endpoint := range []string{"comparison", "status"} {
				code, view, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/comparison/"+endpoint, "", nil)
				if code != 200 || !reflect.DeepEqual(view["draftComparison"], want) {
					t.Fatalf("%s classification: %d %s", endpoint, code, raw)
				}
				for _, secret := range []string{"removed-private-id", "private/invalid", "private-routing.invalid", "secret-password", "private-user", "validation", "endpoint reference missing"} {
					if strings.Contains(raw, secret) {
						t.Fatalf("%s leaked %q: %s", endpoint, secret, raw)
					}
				}
			}
			var after httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "comparison", &after); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, before) {
				t.Fatal("failed candidate comparison mutated frozen publication")
			}
		})
	}
}

func TestOutputComparisonDoesNotInventLegacyOrMissingProfileEvidence(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "comparison-owner")
	p := templateTestProfile("comparison-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	// Explicit historical fixture: this record predates frozen routing metadata.
	legacy := httpapi.Output{ID: "legacy", Name: "Legacy", ProfileID: p.ID, Target: p.Target, Mode: p.Mode, Status: "published"}
	if err := s.TenantPut(owner.id, "outputs", legacy.ID, legacy); err != nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"legacy metadata", "missing profile"} {
		if stage == "missing profile" {
			// The ordinary deletion contract first requires revoking its link.
			code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs/legacy/revoke", owner.csrf, nil)
			if code != 200 {
				t.Fatal(raw)
			}
			legacy.Status = "revoked"
			code, _, raw = req(t, owner.c, "DELETE", srv.URL+"/api/me/profiles/"+p.ID, owner.csrf, nil)
			if code != 200 {
				t.Fatal(raw)
			}
		}
		code, view, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/legacy/comparison", "", nil)
		if code != 200 || !reflect.DeepEqual(view["draftComparison"], map[string]any{"state": "unavailable"}) || view["revision"] != "" {
			t.Fatalf("%s: %d %s", stage, code, raw)
		}
		var after httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", legacy.ID, &after); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(after, legacy) {
			t.Fatalf("%s backfilled historical publication", stage)
		}
	}
}
