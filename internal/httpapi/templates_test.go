package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/reuse"
	"strings"
	"testing"
)

func adminTemplateRequest(t *testing.T, srv *httptest.Server, v any) (int, map[string]any, string) {
	t.Helper()
	b, _ := json.Marshal(v)
	r, _ := http.NewRequest("POST", srv.URL+"/api/admin/templates", bytes.NewReader(b))
	r.Header.Set("Authorization", "Bearer 012345678901234567890123456789012345")
	r.Header.Set("Content-Type", "application/json")
	res, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	json.Unmarshal(raw, &out)
	return res.StatusCode, out, string(raw)
}
func processingTemplate(version int, rename string) map[string]any {
	return map[string]any{"id": "names", "name": "Readable names", "kind": "processing-preset", "expectedVersion": version, "spec": map[string]any{"steps": []any{map[string]any{"id": "rename", "enabled": true, "kind": "rename", "template": rename}}}}
}
func TestTemplatePresetCopyIsIsolatedAndVersionsImmutable(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "template-user")
	status, _, raw := adminTemplateRequest(t, srv, processingTemplate(0, "Shared {name}"))
	if status != 201 {
		t.Fatalf("publish template: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, map[string]any{"id": "collection", "name": "My collection", "sources": []any{}, "steps": []any{}})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"version": 1, "mode": "copy", "targetId": "collection", "target": map[string]any{"adapterId": "mihomo", "version": render.MihomoVersion}})
	if status != 200 {
		t.Fatalf("select copy: %d %s", status, raw)
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "Updated {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, out, raw := req(t, u.c, "GET", srv.URL+"/api/me/collections/collection", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	if out["steps"].([]any)[0].(map[string]any)["template"] != "Shared {name}" {
		t.Fatal("copy changed when upstream changed")
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "Overwrite {name}"))
	if status != 409 {
		t.Fatalf("stale publish overwrote accepted version: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if status != 409 {
		t.Fatalf("copy cannot follow updates: %d %s", status, raw)
	}
}

func TestPinnedPresetStaysPinnedAndFollowRequiresReviewedCandidate(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "preset-user")
	status, _, raw := adminTemplateRequest(t, srv, processingTemplate(0, "Shared {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	for _, mode := range []string{"pinned", "follow"} {
		status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, map[string]any{"id": mode, "name": mode, "sources": []any{}, "steps": []any{}})
		if status != 200 {
			t.Fatal(raw)
		}
		status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"version": 1, "mode": mode, "targetId": mode})
		if status != 200 {
			t.Fatal(raw)
		}
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "New {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, pinned, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_pinned/preview", u.csrf, map[string]any{})
	if status != 200 || pinned["hasUpdate"] != false || pinned["candidateVersion"] != float64(1) {
		t.Fatalf("pin advanced: %d %s", status, raw)
	}
	status, candidate, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_follow/preview", u.csrf, map[string]any{})
	if status != 200 || candidate["compatible"] != true || candidate["candidateVersion"] != float64(2) {
		t.Fatalf("missing follow candidate: %d %s", status, raw)
	}
	status, unchanged, raw := req(t, u.c, "GET", srv.URL+"/api/me/collections/follow", "", nil)
	if status != 200 || unchanged["steps"].([]any)[0].(map[string]any)["template"] != "Shared {name}" {
		t.Fatalf("preview mutated collection: %s", raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_follow/apply", u.csrf, map[string]any{"previewDigest": candidate["previewDigest"]})
	if status != 200 {
		t.Fatalf("apply failed: %d %s", status, raw)
	}
	status, changed, raw := req(t, u.c, "GET", srv.URL+"/api/me/collections/follow", "", nil)
	if status != 200 || changed["steps"].([]any)[0].(map[string]any)["template"] != "New {name}" {
		t.Fatalf("update not applied: %s", raw)
	}
	// A review of version 2 cannot accidentally authorize a newer version 3.
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(2, "Newest {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_follow/apply", u.csrf, map[string]any{"previewDigest": candidate["previewDigest"]})
	if status != 409 {
		t.Fatalf("stale preview accepted: %d %s", status, raw)
	}
}

func TestSharedTemplateRejectsPrivateShapesAndCrossTenantBindings(t *testing.T) {
	s, srv := makeServer(t)
	alice := inviteClient(t, s, srv, "template-alice")
	bob := inviteClient(t, s, srv, "template-bob")
	for _, field := range []string{"endpoints", "resources", "sourceIds", "native", "url", "accessToken"} {
		input := processingTemplate(0, "{name}")
		input["spec"].(map[string]any)[field] = []any{map[string]any{"password": "private-secret"}}
		status, _, raw := adminTemplateRequest(t, srv, input)
		if status != 400 {
			t.Fatalf("unsafe %s accepted: %d %s", field, status, raw)
		}
	}
	profile := templateTestProfile("private", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	status, _, raw := req(t, alice.c, "POST", srv.URL+"/api/me/profiles", alice.csrf, profile)
	if status != 200 {
		t.Fatal(raw)
	}
	spec := reuse.Spec{EndpointSlots: []reuse.Slot{{ID: "exit", Name: "Your exit"}}, DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "exit"}, Runtime: domain.ClientRuntime{MixedPort: 7890}}
	status, _, raw = adminTemplateRequest(t, srv, map[string]any{"id": "profile-template", "name": "Private endpoint slot", "kind": "client-profile", "spec": spec})
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/me/templates/profile-template/select", bob.csrf, map[string]any{"mode": "follow", "targetId": "private", "bindings": map[string]any{"endpoints": map[string]string{"exit": "node"}}})
	if status != 404 || strings.Contains(raw, "secret-password") {
		t.Fatalf("foreign target accessible: %d %s", status, raw)
	}
	own := templateTestProfile("bob-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	own.IR.Endpoints = nil
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/me/profiles", bob.csrf, own)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/me/templates/profile-template/select", bob.csrf, map[string]any{"mode": "follow", "targetId": "bob-profile", "bindings": map[string]any{"endpoints": map[string]string{"exit": "node"}}})
	if status != 422 || strings.Contains(raw, "secret-password") {
		t.Fatalf("foreign endpoint bound: %d %s", status, raw)
	}
	status, _, raw = req(t, alice.c, "POST", srv.URL+"/api/me/templates/profile-template/select", alice.csrf, map[string]any{"mode": "follow", "targetId": "private", "bindings": map[string]any{"endpoints": map[string]string{"exit": "node"}}})
	if status != 200 || strings.Contains(raw, "secret-password") {
		t.Fatalf("owner selection/redacted preview: %d %s", status, raw)
	}
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/me/template-bindings/profiles_private/preview", bob.csrf, map[string]any{})
	if status != 404 {
		t.Fatalf("binding IDOR: %d %s", status, raw)
	}
	status, _, raw = req(t, bob.c, "GET", srv.URL+"/api/templates", "", nil)
	if status != 200 || strings.Contains(raw, "secret-password") || strings.Contains(raw, "192.0.2.9") {
		t.Fatalf("public library leaked: %d %s", status, raw)
	}
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/admin/templates", bob.csrf, processingTemplate(0, "{name}"))
	if status != 403 {
		t.Fatalf("publish RBAC: %d %s", status, raw)
	}
}

func templateTestProfile(id string, target render.Target) httpapi.Profile {
	return httpapi.Profile{ID: id, Name: "Private profile", Target: target, Mode: render.FullConfig, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "direct"}, Runtime: domain.ClientRuntime{MixedPort: 7890}, Endpoints: []domain.ClientEndpoint{{ID: "node", Name: "Private node", Origin: "imported", Connection: domain.Connection{Host: "192.0.2.9", Port: 1080, Protocol: "socks", Username: "private-user", Password: "secret-password"}}}}}
}
func profileTemplate(version int, spec reuse.Spec) map[string]any {
	return map[string]any{"id": "profile-library", "name": "Policy template", "kind": "client-profile", "expectedVersion": version, "spec": spec}
}
func baseProfileSpec() reuse.Spec {
	return reuse.Spec{Groups: []reuse.Group{{ID: "proxy", Name: "Shared group", Kind: "manual", Members: []domain.ActionRef{{Kind: "direct"}}}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "proxy"}, Runtime: domain.ClientRuntime{MixedPort: 7890}}
}

func TestProfileTemplatePreservesPersonalOverridesAndPublishedFallback(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "profile-template-user")
	status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("profile", render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}))
	if status != 200 {
		t.Fatal(raw)
	}
	spec := baseProfileSpec()
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "follow", "version": 1, "targetId": "profile"})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	var personal httpapi.Profile
	if e := json.Unmarshal([]byte(raw), &personal); e != nil {
		t.Fatal(e)
	}
	personal.IR.Groups[0].Name = "Personal group"
	personal.IR.Runtime.MixedPort = 9999
	status, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/profile", personal)
	if status != 200 {
		t.Fatal(raw)
	}
	spec.Groups[0].Name = "Upstream group"
	spec.Runtime.MixedPort = 8888
	spec.Rules = []domain.PolicyRule{{ID: "block", Match: domain.MatchExpression{Op: "domain", Value: "blocked.example"}, Action: domain.ActionRef{Kind: "reject"}}}
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(1, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/preview", u.csrf, map[string]any{})
	if status != 200 || preview["compatible"] != true {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if status != 200 {
		t.Fatalf("apply: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	var updated httpapi.Profile
	json.Unmarshal([]byte(raw), &updated)
	if updated.IR.Groups[0].Name != "Personal group" || updated.IR.Runtime.MixedPort != 9999 || len(updated.IR.Rules) != 1 || updated.IR.Endpoints[0].Connection.Password != "secret-password" {
		t.Fatalf("local edits/private data lost: %+v", updated)
	}
	status, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "feed", "name": "My feed", "profileId": "profile"})
	if status != 201 {
		t.Fatal(raw)
	}
	path := out["feedPath"].(string)
	status, _, before := req(t, http.DefaultClient, "GET", srv.URL+path, "", nil)
	if status != 200 {
		t.Fatal(before)
	}
	spec.Groups = append(spec.Groups, reuse.Group{ID: "fallback", Name: "Unsupported fallback", Kind: "fallback", Members: []domain.ActionRef{{Kind: "direct"}}, IntervalSeconds: 300})
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(2, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, preview, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/preview", u.csrf, map[string]any{})
	if status != 200 || preview["compatible"] != false {
		t.Fatalf("incompatible candidate marked usable: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if status != 422 {
		t.Fatalf("incompatible candidate applied: %d %s", status, raw)
	}
	status, _, after := req(t, http.DefaultClient, "GET", srv.URL+path, "", nil)
	if status != 200 || after != before {
		t.Fatal("incompatible update changed last valid subscription")
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	json.Unmarshal([]byte(raw), &updated)
	if len(updated.IR.Groups) != 1 {
		t.Fatal("incompatible update changed saved profile")
	}
}

func TestProcessingPresetRendersPrivateSourcesAndProtectsDependentProfiles(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "processing-profile-user")
	status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, map[string]any{"id": "source", "name": "My source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-secret@192.0.2.10:1080#Original", "enabled": true})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, map[string]any{"id": "collection", "name": "Collection", "sources": []any{map[string]any{"sourceId": "source", "steps": []any{}}}, "steps": []any{}})
	if status != 200 {
		t.Fatal(raw)
	}
	p := templateTestProfile("dependent", render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion})
	p.IR.Endpoints = nil
	p.CollectionID = "collection"
	p.IR.Groups = []domain.PolicyGroup{{ID: "proxy", Name: "My nodes", Kind: "manual", Dynamic: &domain.EndpointFilter{}}}
	p.IR.DefaultAction = domain.ActionRef{Kind: "group", Ref: "proxy"}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(0, "Shared {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"mode": "follow", "targetId": "collection", "target": p.Target})
	if status != 200 {
		t.Fatal(raw)
	}
	status, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/collections/collection/preview", u.csrf, map[string]any{})
	if status != 200 || preview["endpoints"].([]any)[0].(map[string]any)["name"] != "Shared Original" || strings.Contains(raw, "fixture-secret") {
		t.Fatalf("processing not applied/redacted: %d %s", status, raw)
	}
	status, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "feed", "name": "Dependent feed", "profileId": "dependent"})
	if status != 201 {
		t.Fatal(raw)
	}
	path := out["feedPath"].(string)
	status, _, before := req(t, http.DefaultClient, "GET", srv.URL+path, "", nil)
	if status != 200 {
		t.Fatal(before)
	}
	update := processingTemplate(1, "{name}")
	update["spec"] = map[string]any{"steps": []any{map[string]any{"id": "drop-all", "kind": "drop", "enabled": true}}}
	status, _, raw = adminTemplateRequest(t, srv, update)
	if status != 201 {
		t.Fatal(raw)
	}
	status, preview, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if status != 200 || preview["compatible"] != false {
		t.Fatalf("dependent profile breakage missed: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if status != 422 {
		t.Fatal(raw)
	}
	status, _, after := req(t, http.DefaultClient, "GET", srv.URL+path, "", nil)
	if status != 200 || before != after {
		t.Fatal("processing update replaced valid published feed")
	}
}

func TestFollowedProfileCanReviewNewPrivateBindingWithoutPublishingSecrets(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "new-binding-user")
	status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}))
	if status != 200 {
		t.Fatal(raw)
	}
	spec := baseProfileSpec()
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "follow", "targetId": "profile"})
	if status != 200 {
		t.Fatal(raw)
	}
	spec.EndpointSlots = []reuse.Slot{{ID: "exit", Name: "Choose your exit"}}
	spec.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "exit"}}
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(1, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, pending, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/preview", u.csrf, map[string]any{})
	if status != 200 || pending["compatible"] != false {
		t.Fatalf("missing private binding did not block: %d %s", status, raw)
	}
	binding := reuse.Bindings{Endpoints: map[string]string{"exit": "node"}}
	status, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/preview", u.csrf, map[string]any{"bindings": binding})
	if status != 200 || preview["compatible"] != true || strings.Contains(raw, "secret-password") {
		t.Fatalf("bound preview: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"], "bindings": binding})
	if status != 200 {
		t.Fatalf("bound apply: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	var p httpapi.Profile
	json.Unmarshal([]byte(raw), &p)
	if p.IR.Groups[0].Members[0].Ref != "node" {
		t.Fatal("new slot not materialized")
	}
}

func TestTemplateImmutableHistorySurvivesConcurrentPublication(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "version-reader")
	status, first, raw := adminTemplateRequest(t, srv, processingTemplate(0, "First {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	results := make(chan int, 2)
	for _, name := range []string{"Second {name}", "Competing {name}"} {
		go func(name string) {
			body, _ := json.Marshal(processingTemplate(1, name))
			request, _ := http.NewRequest("POST", srv.URL+"/api/admin/templates", bytes.NewReader(body))
			request.Header.Set("Authorization", "Bearer 012345678901234567890123456789012345")
			request.Header.Set("Content-Type", "application/json")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				results <- -1
				return
			}
			defer response.Body.Close()
			results <- response.StatusCode
		}(name)
	}
	a, b := <-results, <-results
	if !(a == 201 && b == 409 || a == 409 && b == 201) {
		t.Fatalf("expected one concurrent publish winner, got %d %d", a, b)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/templates/names/versions", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	var versions []httpapi.TemplateVersion
	if e := json.Unmarshal([]byte(raw), &versions); e != nil {
		t.Fatal(e)
	}
	if len(versions) != 2 || versions[0].Version != 1 || versions[1].Version != 2 || versions[0].Digest != first["digest"] || versions[0].Spec.Steps[0].Template != "First {name}" {
		t.Fatalf("immutable version changed: %s", raw)
	}
}

func TestPinnedVersionAdvancesOnlyByExplicitReviewedUpgrade(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "pin-upgrade-user")
	status, _, raw := adminTemplateRequest(t, srv, processingTemplate(0, "First {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, map[string]any{"id": "collection", "name": "Collection", "sources": []any{}, "steps": []any{}})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"mode": "pinned", "targetId": "collection", "version": 1})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "Second {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{"version": 2})
	if status != 200 || preview["hasUpdate"] != true || preview["candidateVersion"] != float64(2) {
		t.Fatalf("explicit upgrade preview failed: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/apply", u.csrf, map[string]any{"version": 2, "previewDigest": preview["previewDigest"]})
	if status != 200 {
		t.Fatalf("explicit upgrade failed: %d %s", status, raw)
	}
	status, _, raw = adminTemplateRequest(t, srv, processingTemplate(2, "Third {name}"))
	if status != 201 {
		t.Fatal(raw)
	}
	status, preview, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if status != 200 || preview["hasUpdate"] != false || preview["candidateVersion"] != float64(2) {
		t.Fatalf("new pin followed automatically: %d %s", status, raw)
	}
}

func TestSwitchingTemplateReferenceModeKeepsPersonalRuntimeAndPrivateBindings(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "reference-mode-user")
	status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}))
	if status != 200 {
		t.Fatal(raw)
	}
	spec := baseProfileSpec()
	spec.EndpointSlots = []reuse.Slot{{ID: "exit", Name: "Exit"}}
	spec.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "exit"}}
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "follow", "targetId": "profile", "bindings": reuse.Bindings{Endpoints: map[string]string{"exit": "node"}}})
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	var p httpapi.Profile
	json.Unmarshal([]byte(raw), &p)
	p.IR.Runtime.MixedPort = 9999
	p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
	status, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/profile", p)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "pinned", "targetId": "profile", "version": 1})
	if status != 200 {
		t.Fatalf("mode switch lost binding: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
	if status != 200 {
		t.Fatal(raw)
	}
	json.Unmarshal([]byte(raw), &p)
	if p.IR.Runtime.MixedPort != 9999 || p.IR.DefaultAction.Kind != "direct" || p.IR.Groups[0].Members[0].Ref != "node" {
		t.Fatal("mode switch overwrote personal policy")
	}
}

// Public HTTP tracer: equal rule counts do not mean equal routing decisions.
func TestTemplateUpdateReviewDescribesActualDraftAndMergedCandidate(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "template-routing-review")
	p := templateTestProfile("review-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Endpoints = []domain.ClientEndpoint{
		{ID: "tokyo", Name: "Tokyo", Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.20", Port: 1080}},
		{ID: "london", Name: "London", Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.30", Port: 1080}},
	}
	status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if status != 200 {
		t.Fatalf("create valid profile: %d %s", status, raw)
	}
	spec := reuse.Spec{
		EndpointSlots: []reuse.Slot{{ID: "east", Name: "East exit"}, {ID: "west", Name: "West exit"}},
		Rules: []domain.PolicyRule{
			{ID: "work", Match: domain.MatchExpression{Op: "domain-suffix", Value: "work.example"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "east"}},
			{ID: "local", Match: domain.MatchExpression{Op: "domain-suffix", Value: "local.example"}, Action: domain.ActionRef{Kind: "direct"}},
		},
		DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "east"},
		Runtime:       domain.ClientRuntime{MixedPort: 7890},
	}
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
	if status != 201 {
		t.Fatalf("publish v1: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{
		"mode": "follow", "version": 1, "targetId": p.ID,
		"bindings": reuse.Bindings{Endpoints: map[string]string{"east": "tokyo", "west": "london"}},
	})
	if status != 200 {
		t.Fatalf("select valid v1: %d %s", status, raw)
	}
	status, _, savedBefore := req(t, u.c, "GET", srv.URL+"/api/me/profiles/"+p.ID+"/reveal", "", nil)
	if status != 200 {
		t.Fatalf("read draft before review: %d", status)
	}
	spec.Rules[0].Action = domain.ActionRef{Kind: "endpoint", Ref: "west"}
	spec.DefaultAction = domain.ActionRef{Kind: "direct"}
	status, _, raw = adminTemplateRequest(t, srv, profileTemplate(1, spec))
	if status != 201 {
		t.Fatalf("publish v2: %d %s", status, raw)
	}
	bindingURL := srv.URL + "/api/me/template-bindings/profiles_" + p.ID
	status, preview, raw := req(t, u.c, "POST", bindingURL+"/preview", u.csrf, map[string]any{"version": 2})
	if status != 200 || preview["compatible"] != true || preview["hasUpdate"] != true {
		t.Fatalf("fixture must reach a valid update, not a setup failure: %d %s", status, raw)
	}
	status, _, savedAfterPreview := req(t, u.c, "GET", srv.URL+"/api/me/profiles/"+p.ID+"/reveal", "", nil)
	if status != 200 || savedAfterPreview != savedBefore {
		t.Fatal("review mutated the persisted draft")
	}
	var response struct {
		Review *struct {
			Version int    `json:"version"`
			Scope   string `json:"scope"`
			Current struct {
				State  string                       `json:"state"`
				Intent *httpapi.FrozenRoutingIntent `json:"intent"`
			} `json:"current"`
			Candidate struct {
				State  string                       `json:"state"`
				Intent *httpapi.FrozenRoutingIntent `json:"intent"`
			} `json:"candidate"`
		} `json:"review"`
	}
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if response.Review == nil {
		t.Fatal("valid template update omitted current-to-candidate routing review")
	}
	r := response.Review
	if r.Version != 1 || r.Scope != "profile-routing" || r.Current.State != "available" || r.Candidate.State != "available" {
		t.Fatalf("unexpected review coverage: %+v", r)
	}
	before, after := r.Current.Intent, r.Candidate.Intent
	if before == nil || after == nil || before.Kind != "portable" || after.Kind != "portable" || before.FrozenPortableRoutingIntent == nil || after.FrozenPortableRoutingIntent == nil {
		t.Fatal("valid portable candidates need both routing intents")
	}
	if before.RuleCount != 2 || after.RuleCount != 2 || len(before.Rules) != 2 || len(after.Rules) != 2 {
		t.Fatal("equal-count two-rule fixture lost rows")
	}
	if before.Rules[0].ID != "work" || after.Rules[0].ID != "work" || before.Rules[1].ID != "local" || after.Rules[1].ID != "local" {
		t.Fatal("stable rule identities/order lost")
	}
	if before.Rules[0].Action != (httpapi.FrozenRoutingAction{Kind: "endpoint", Ref: "tokyo", Label: "Tokyo"}) || after.Rules[0].Action != (httpapi.FrozenRoutingAction{Kind: "endpoint", Ref: "london", Label: "London"}) {
		t.Fatal("review did not describe Tokyo to London")
	}
	if before.DefaultAction == nil || *before.DefaultAction != (httpapi.FrozenRoutingAction{Kind: "endpoint", Ref: "tokyo", Label: "Tokyo"}) || after.DefaultAction == nil || *after.DefaultAction != (httpapi.FrozenRoutingAction{Kind: "direct"}) {
		t.Fatal("review omitted endpoint to direct default change")
	}
	if before.Rules[0].Match.Expression == nil || before.Rules[0].Match.Expression.Value != "work.example" || after.Rules[0].Match.Expression == nil || after.Rules[0].Match.Expression.Value != "work.example" {
		t.Fatal("review lost unchanged matching condition")
	}
	digest, ok := preview["previewDigest"].(string)
	if !ok || digest == "" {
		t.Fatal("review lacks apply authority")
	}
	status, _, raw = req(t, u.c, "POST", bindingURL+"/apply", u.csrf, map[string]any{"version": 2, "previewDigest": "not-the-reviewed-digest"})
	if status != 409 {
		t.Fatalf("unreviewed digest applied: %d %s", status, raw)
	}
	status, _, unchanged := req(t, u.c, "GET", srv.URL+"/api/me/profiles/"+p.ID+"/reveal", "", nil)
	if status != 200 || unchanged != savedBefore {
		t.Fatal("rejected apply changed draft")
	}
	status, _, raw = req(t, u.c, "POST", bindingURL+"/apply", u.csrf, map[string]any{"version": 2, "previewDigest": digest})
	if status != 200 {
		t.Fatalf("explicit reviewed apply: %d %s", status, raw)
	}
	status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/"+p.ID+"/reveal", "", nil)
	if status != 200 {
		t.Fatal("read updated draft failed")
	}
	var applied httpapi.Profile
	if err := json.Unmarshal([]byte(raw), &applied); err != nil {
		t.Fatal(err)
	}
	if len(applied.IR.Rules) != 2 || applied.IR.Rules[0].ID != "work" || applied.IR.Rules[0].Action != (domain.ActionRef{Kind: "endpoint", Ref: "london"}) || applied.IR.DefaultAction != (domain.ActionRef{Kind: "direct"}) {
		t.Fatal("applied draft differs from reviewed candidate")
	}
}
