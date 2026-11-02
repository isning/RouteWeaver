package httpapi_test

import (
	"encoding/json"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func nativeProfile(target render.Target, content string) httpapi.Profile {
	p := templateTestProfile("native-profile", target)
	p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: target.AdapterID, Version: target.Version}, Format: "json", RuleMode: "prepend", Content: content}
	return p
}
func TestNativeDraftContentIsOwnerPrivateAndSurvivesInvalidSave(t *testing.T) {
	s, srv := makeServer(t)
	alice := inviteClient(t, s, srv, "native-alice")
	bob := inviteClient(t, s, srv, "native-bob")
	content := `{"dns":{"nameserver":["https://dns.example/dns-query?key=synthetic-native-private"]},"unknown":"unfinished"`
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, content)
	code, out, raw := req(t, alice.c, "POST", srv.URL+"/api/me/profiles", alice.csrf, p)
	if code != 200 {
		t.Fatalf("invalid raw draft was discarded: %d %s", code, raw)
	}
	if strings.Contains(raw, "synthetic-native-private") {
		t.Fatal("save response leaked raw native draft")
	}
	if len(out["diagnostics"].([]any)) == 0 {
		t.Fatal("invalid native draft missing diagnostic")
	}
	for _, path := range []string{"/api/me/profiles", "/api/me/profiles/native-profile"} {
		code, _, raw = req(t, alice.c, "GET", srv.URL+path, "", nil)
		if code != 200 || strings.Contains(raw, "synthetic-native-private") {
			t.Fatalf("ordinary native profile view leaked content: %d %s", code, raw)
		}
	}
	code, _, raw = req(t, alice.c, "GET", srv.URL+"/api/me/profiles/native-profile/reveal", "", nil)
	var saved httpapi.Profile
	if code != 200 || json.Unmarshal([]byte(raw), &saved) != nil || saved.IR.NativeOverride.Content != content {
		t.Fatalf("explicit owner reveal lost exact raw draft: %d %s", code, raw)
	}
	for _, path := range []string{"/api/me/profiles/native-profile", "/api/me/profiles/native-profile/reveal"} {
		code, _, raw = req(t, bob.c, "GET", srv.URL+path, "", nil)
		if code != 404 || strings.Contains(raw, "synthetic-native-private") {
			t.Fatalf("foreign native profile exposed: %d %s", code, raw)
		}
	}
	code, _, raw = req(t, alice.c, "POST", srv.URL+"/api/me/outputs", alice.csrf, map[string]any{"id": "bad-native", "name": "Invalid native", "profileId": p.ID})
	if code != 422 || strings.Contains(raw, "synthetic-native-private") {
		t.Fatalf("invalid native draft published or diagnostic leaked: %d %s", code, raw)
	}
}
func TestNativePreviewAndPublishedOutputUseSameFinalComposition(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "native-output-user")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"dns":{"enable":true,"enhanced-mode":"fake-ip","nameserver":["https://1.1.1.1/dns-query"]},"rules":["PROCESS-NAME,curl,DIRECT"]}`)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", u.csrf, map[string]any{})
	if code != 200 || !strings.Contains(raw, "PROCESS-NAME,curl,DIRECT") || preview["nativeOverride"] == nil {
		t.Fatalf("preview omitted final native result/report: %d %s", code, raw)
	}
	code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/native-profile/reveal", "", nil)
	if code != 200 {
		t.Fatal(raw)
	}
	var saved httpapi.Profile
	_ = json.Unmarshal([]byte(raw), &saved)
	exact, err := render.DefaultClients().Render(saved.IR, saved.Target, saved.Mode)
	if err != nil {
		t.Fatal(err)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-output", "name": "Native output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || feed != exact.Artifacts[0].Content {
		t.Fatal("published bytes differ from exact renderer native result")
	}
	// A changed target never silently drops native edits, and a bad draft never
	// mutates the immutable currently published subscription.
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", u.csrf, map[string]any{"target": render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}})
	if code != 422 || !strings.Contains(raw, "NATIVE_TARGET_MISMATCH") {
		t.Fatalf("target switch dropped native edit: %d %s", code, raw)
	}
	saved.IR.NativeOverride.Content = `{"proxies":[{"name":"Injected","password":"synthetic-native-private"}]}`
	code, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/native-profile", saved)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/native-output/publish", u.csrf, map[string]any{})
	if code != 422 {
		t.Fatalf("managed credentials overridden: %d %s", code, raw)
	}
	code, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || after != feed {
		t.Fatal("invalid native draft changed published content")
	}
}

func TestNativePreviewRedactsURLAuthenticationButExportRetainsExactData(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "native-url-user")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"dns":{"enable":true,"nameserver":["https://dns.example/dns-query?key=synthetic-native-url-secret"]}}`)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", u.csrf, map[string]any{})
	if code != 200 || strings.Contains(raw, "synthetic-native-url-secret") {
		t.Fatalf("normal preview exposes URL authentication: %d %s", code, raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-output", "name": "Native output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || !strings.Contains(raw, "synthetic-native-url-secret") {
		t.Fatal("published native content was corrupted by preview redaction")
	}
}

func TestNativeOverrideSurvivesTemplateFollowAndKeepsPublicationSeparate(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "native-template-owner")
	content := "{\n  \"rules\": [\"PROCESS-NAME,curl,DIRECT\"],\n  \"tcp-concurrent\": true\n}\n"
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, content)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	spec := baseProfileSpec()
	code, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "follow", "targetId": p.ID, "version": 1})
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-output", "name": "Native output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatal(feed)
	}
	spec.Rules = []domain.PolicyRule{{ID: "template-rule", Match: domain.MatchExpression{Op: "domain", Value: "template.example"}, Action: domain.ActionRef{Kind: "reject"}}}
	code, _, raw = adminTemplateRequest(t, srv, profileTemplate(1, spec))
	if code != 201 {
		t.Fatal(raw)
	}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_native-profile/preview", u.csrf, map[string]any{})
	if code != 200 || preview["compatible"] != true || !strings.Contains(raw, "PROCESS-NAME,curl,DIRECT") || !strings.Contains(raw, "template.example") {
		t.Fatalf("followed preview lost native or template edits: %d %s", code, raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_native-profile/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/native-profile/reveal", "", nil)
	var saved httpapi.Profile
	if code != 200 || json.Unmarshal([]byte(raw), &saved) != nil || saved.IR.NativeOverride == nil || saved.IR.NativeOverride.Content != content {
		t.Fatalf("template update rewrote native bytes: %d %s", code, raw)
	}
	code, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || after != feed {
		t.Fatal("template/native draft changed published subscription without publishing")
	}
}

func TestNativeOutputScopedPreviewRetainsNamesWhenCollisionsChange(t *testing.T) {
	for _, change := range []string{"add-collision", "remove-collision"} {
		t.Run(change, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "native-name-owner")
			foreign := inviteClient(t, s, srv, "native-name-foreign")
			p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
			p.IR.Endpoints[0].Name = "Same"
			p.IR.Endpoints[0].Connection.Username = ""
			p.IR.Endpoints[0].Connection.Password = ""
			second := p.IR.Endpoints[0]
			second.ID = "second"
			second.Connection.Host = "192.0.2.10"
			if change == "remove-collision" {
				p.IR.Endpoints = append(p.IR.Endpoints, second)
			}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "named-output", "name": "Stable device names", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			code, initial, raw := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 {
				t.Fatal(raw)
			}
			selectedName := initial["proxies"].([]any)[0].(map[string]any)["name"].(string)
			if change == "remove-collision" {
				p.IR.Endpoints = p.IR.Endpoints[:1]
			} else {
				p.IR.Endpoints = append(p.IR.Endpoints, second)
			}
			content, _ := json.Marshal(map[string]any{"rules": []string{"PROCESS-NAME,curl," + selectedName}})
			p.IR.NativeOverride.Content = string(content)
			code, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/native-profile", p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", u.csrf, map[string]any{"outputId": "named-output"})
			if code != 200 || preview["outputId"] != "named-output" || preview["previewScope"] != "output-update" {
				t.Fatalf("output-scoped preview failed to retain published names: %d %s", code, raw)
			}
			previewContent := preview["artifacts"].([]any)[0].(map[string]any)["content"].(string)
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/named-output/publish", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 || strings.TrimSuffix(feed, "\n") != previewContent {
				t.Fatal("output preview differs from republished bytes with no secret redactions")
			}
			// Cross-tenant or different-profile output IDs cannot supply allocations.
			other := nativeProfile(p.Target, `{}`)
			other.ID = "other-profile"
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, other)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles/other-profile/preview", u.csrf, map[string]any{"outputId": "named-output"})
			if code != 409 {
				t.Fatalf("other profile's names accepted: %d %s", code, raw)
			}
			code, _, raw = req(t, foreign.c, "POST", srv.URL+"/api/me/profiles", foreign.csrf, nativeProfile(p.Target, `{}`))
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, foreign.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", foreign.csrf, map[string]any{"outputId": "named-output"})
			if code != 404 {
				t.Fatalf("foreign output read: %d %s", code, raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles/native-profile/preview", u.csrf, map[string]any{"outputId": "named-output", "target": render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}})
			if code != 409 {
				t.Fatalf("preview silently substituted output target: %d %s", code, raw)
			}
		})
	}
}
