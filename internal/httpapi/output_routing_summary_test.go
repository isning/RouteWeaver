package httpapi_test

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func basicSummaryProfile() httpapi.Profile {
	p := templateTestProfile("basic-summary", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Endpoints[0].Name = "Original route"
	p.IR.Groups = []domain.PolicyGroup{
		{ID: "basic_chatgpt", Name: "ChatGPT", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "node"}}},
		{ID: "basic_default", Name: "其他流量", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "node"}}},
	}
	p.IR.DefaultAction = domain.ActionRef{Kind: "group", Ref: "basic_default"}
	for i, d := range []string{"chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"} {
		p.IR.Rules = append(p.IR.Rules, domain.PolicyRule{ID: fmt.Sprintf("basic_chatgpt_%d", i), Match: domain.MatchExpression{Op: "domain-suffix", Value: d}, Action: domain.ActionRef{Kind: "group", Ref: "basic_chatgpt"}})
	}
	return p
}
func TestPublishedRoutingSummaryStaysFrozenUntilReviewedPublication(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "routing-summary")
	p := basicSummaryProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "summary", "name": "Summary", "profileId": p.ID, "routingSummary": map[string]any{"version": 1, "kind": "basic", "chatGPT": map[string]any{"endpointId": "forged", "label": "Forged"}}})
	if code != 400 {
		t.Fatalf("client-controlled summary accepted: %d %s", code, raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "summary", "name": "Summary", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	summary, ok := out["routingSummary"].(map[string]any)
	if !ok || summary["kind"] != "basic" {
		t.Fatalf("missing basic published summary: %s", raw)
	}
	if summary["chatGPT"].(map[string]any)["label"] != "Original route" {
		t.Fatal(summary)
	}
	status := func(want string) map[string]any {
		t.Helper()
		code, v, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/summary/status", "", nil)
		if code != 200 {
			t.Fatal(raw)
		}
		if v["draftComparison"].(map[string]any)["state"] != want {
			t.Fatalf("want %s: %s", want, raw)
		}
		for _, secret := range []string{"secret-password", "private-user", "feedPath", "bundlePath", "tokenDigest"} {
			if strings.Contains(raw, secret) {
				t.Fatalf("status leaked %s", secret)
			}
		}
		return v
	}
	status("unchanged")
	p.IR.Endpoints[0].Name = "New route"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	current := status("changed")
	if current["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "Original route" {
		t.Fatal("draft rewrote frozen summary")
	}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "summary"})
	if code != 200 {
		t.Fatal(raw)
	}
	if preview["publishedRoutingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "Original route" || preview["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "New route" {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/summary/publish", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	status("unchanged")
	code, _, publishedFeed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatal(publishedFeed)
	}
	// Secret-only changes must not disappear behind identical redacted previews.
	p.IR.Endpoints[0].Connection.Password = "changed-secret"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	status("changed")
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/summary/publish", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 409 {
		t.Fatalf("stale review accepted: %d %s", code, raw)
	}
	p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: p.Target.AdapterID, Version: p.Target.Version}, Format: "json", RuleMode: "prepend", Content: `{"broken"`}
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	current = status("unavailable")
	if current["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "New route" {
		t.Fatal("failed preparation lost publication")
	}
	code, _, feedAfterFailure := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || feedAfterFailure != publishedFeed {
		t.Fatalf("unavailable draft disturbed eligible frozen feed: %d", code)
	}
}

func TestPublishedRoutingSummaryOpaqueKindsAndSecretFreeLabels(t *testing.T) {
	for _, scenario := range []string{"native-override", "nodes-only", "advanced", "url-label", "credential-label", "sing-box"} {
		t.Run(scenario, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "summary-kinds")
			p := basicSummaryProfile()
			want := "basic"
			switch scenario {
			case "native-override":
				want = scenario
				p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: p.Target.AdapterID, Version: p.Target.Version}, Format: "json", RuleMode: "prepend", Content: `{"rules":["DOMAIN-SUFFIX,chatgpt.com,DIRECT"]}`}
			case "nodes-only":
				want = scenario
				p.Mode = render.NodesOnly
			case "advanced":
				want = scenario
				p.IR.Rules[0].Match.Value = "different.example"
			case "url-label":
				p.IR.Endpoints[0].Name = "https://secret.example/feed/opaque-bearer"
			case "credential-label":
				p.IR.Endpoints[0].Name = "secret-password"
			case "sing-box":
				p.Target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
			}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			request := map[string]any{"id": "summary", "name": "Summary", "profileId": p.ID}
			code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, request)
			if code != 200 {
				t.Fatal(raw)
			}
			summary, ok := preview["routingSummary"].(map[string]any)
			if !ok || summary["kind"] != want {
				t.Fatalf("want %s: %s", want, raw)
			}
			if want != "basic" && (summary["chatGPT"] != nil || summary["default"] != nil) {
				t.Fatal("opaque configuration invented routes")
			}
			if want != "advanced" && summary["advanced"] != nil {
				t.Fatal("basic, nodes-only or native configuration invented advanced details")
			}
			request["previewDigest"] = preview["previewDigest"]
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, request)
			if code != 201 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
			if code != 200 {
				t.Fatal(raw)
			}
			for _, secret := range []string{"secret-password", "private-user", "opaque-bearer", "secret.example", "feedPath", "bundlePath", "artifacts", "connection"} {
				if strings.Contains(raw, secret) {
					t.Fatalf("normal metadata leaked %s: %s", secret, raw)
				}
			}
		})
	}
}

func TestPublishedRoutingSummaryLegacyUnavailableAndTenantIsolation(t *testing.T) {
	s, srv := makeServer(t)
	alice := inviteClient(t, s, srv, "summary-alice")
	bob := inviteClient(t, s, srv, "summary-bob")
	p := basicSummaryProfile()
	code, _, raw := req(t, alice.c, "POST", srv.URL+"/api/me/profiles", alice.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	// Seed a historical record that predates routing summaries. Do not rebuild it
	// from the current draft or imply that the current draft was ever published.
	if err := s.TenantPut(alice.id, "outputs", "legacy", httpapi.Output{ID: "legacy", Name: "Legacy", ProfileID: p.ID, Target: p.Target, Mode: p.Mode, Status: "published"}); err != nil {
		t.Fatal(err)
	}
	code, status, raw := req(t, alice.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
	if code != 200 || status["routingSummary"] != nil || status["draftComparison"].(map[string]any)["state"] != "unavailable" {
		t.Fatal(raw)
	}
	code, _, raw = req(t, bob.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
	if code != 404 {
		t.Fatalf("cross-tenant status: %d %s", code, raw)
	}
}

func TestPublishedRoutingSummaryDetectsFrozenRuleFileChanges(t *testing.T) {
	for _, kind := range []string{"detailed", "legacy"} {
		t.Run(kind, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "summary-files")
			upload := map[string]any{"resource": map[string]any{"id": "private-rules", "name": "Private rules", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.original-private.example'\n"))}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
			if code != 201 {
				t.Fatal(raw)
			}
			p := templateTestProfile("files", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			p.IR.Resources = []domain.RuleResource{{ID: "private-rules"}}
			p.IR.Rules = []domain.PolicyRule{{ID: "file-rule", Match: domain.MatchExpression{Op: "resource", Value: "private-rules"}, Action: domain.ActionRef{Kind: "reject"}}}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "files", "name": "Files", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			if kind == "legacy" {
				var published httpapi.Output
				if err := s.TenantGet(u.id, "outputs", "files", &published); err != nil {
					t.Fatal(err)
				}
				published.RoutingSummary = &httpapi.RoutingSummary{Version: 1, Kind: "advanced"}
				if err := s.TenantPut(u.id, "outputs", "files", published); err != nil {
					t.Fatal(err)
				}
			}
			code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/files/status", "", nil)
			if code != 200 || status["draftComparison"].(map[string]any)["state"] != "unchanged" {
				t.Fatal(raw)
			}
			code, before, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "files"})
			if code != 200 {
				t.Fatal(raw)
			}
			upload["contentBase64"] = base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.changed-private.example'\n"))
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
			if code != 201 {
				t.Fatal(raw)
			}
			code, status, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs/files/status", "", nil)
			if code != 200 || status["draftComparison"].(map[string]any)["state"] != "changed" {
				t.Fatal(raw)
			}
			if strings.Contains(raw, "private.example") || strings.Contains(raw, "contentBase64") || strings.Contains(raw, "resourceFiles") {
				t.Fatal("private file bytes exposed by status")
			}
			code, after, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "files"})
			if code != 200 {
				t.Fatal(raw)
			}
			if !reflect.DeepEqual(before["names"], after["names"]) || !reflect.DeepEqual(before["routingSummary"], after["routingSummary"]) {
				t.Fatal("file fixture must keep names and routing summary identical")
			}

		})
	}
}

func TestPublishedRoutingSummarySourceRenameChangesCandidateOnly(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "summary-source")
	source := map[string]any{"id": "source", "name": "Airport", "kind": "text", "content": "socks5://one.example:1080#Original", "enabled": true}
	code, initial, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	endpointID := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"].(string)
	p := basicSummaryProfile()
	p.SourceIDs = []string{"source"}
	p.IR.Endpoints = nil
	for i := range p.IR.Groups {
		p.IR.Groups[i].Members[0].Ref = endpointID
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "source-output", "name": "Source output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, before, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "source-output"})
	if code != 200 {
		t.Fatal(raw)
	}
	source["content"] = "socks5://one.example:1080#Renamed"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/sources/source", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/source-output/status", "", nil)
	if code != 200 || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal(raw)
	}
	if status["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "Original" {
		t.Fatal("source rename rewrote published label")
	}
	code, after, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "source-output"})
	if code != 200 {
		t.Fatal(raw)
	}
	if after["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["label"] != "Renamed" {
		t.Fatal(raw)
	}
	if before["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["endpointId"] != after["routingSummary"].(map[string]any)["chatGPT"].(map[string]any)["endpointId"] {
		t.Fatal("source rename changed endpoint identity")
	}
}

func TestPublishedRoutingSummaryUsesDeliveredAllocatedNames(t *testing.T) {
	for _, label := range []string{"Region,One", strings.Repeat("x", 160)} {
		t.Run(label[:6], func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "summary-names")
			p := basicSummaryProfile()
			p.IR.Endpoints[0].Name = label
			second := p.IR.Endpoints[0]
			second.ID = "second-node"
			second.Connection.Host = "192.0.2.11"
			p.IR.Endpoints = append(p.IR.Endpoints, second)
			p.IR.Groups[1].Members[0].Ref = second.ID
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "names", "name": "Names", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			summary := out["routingSummary"].(map[string]any)
			want := label
			if label == "Region,One" {
				want = "Region，One"
			}
			if summary["chatGPT"].(map[string]any)["label"] != want || summary["default"].(map[string]any)["label"] != want+" · d411e3" {
				t.Fatalf("summary does not preserve normalized allocated names: %s", raw)
			}
			if label == "Region,One" {
				// Equivalent spelling normalizes to the same delivered names and bytes.
				for i := range p.IR.Endpoints {
					p.IR.Endpoints[i].Name = "Region，One"
				}
				code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
				if code != 200 {
					t.Fatal(raw)
				}
				code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/names/status", "", nil)
				if code != 200 || status["draftComparison"].(map[string]any)["state"] != "unchanged" {
					t.Fatalf("equivalent rendered names caused false pending changes: %s", raw)
				}
			}
		})
	}
}

func TestPublishedRoutingSummaryRedactsNormalizedCredentialLabels(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		for _, example := range []struct{ name, secret, label, want string }{
			{"normalized", "secret,password", "secret,password", "[REDACTED]"},
			{"trimmed", " secret-password ", " secret-password ", "[REDACTED]"},
			{"normalized-trimmed", " secret,password ", " secret,password ", "[REDACTED]"},
			{"embedded", " secret,password ", "prefix secret,password suffix", "prefix[REDACTED]suffix"},
		} {
			t.Run(target.AdapterID+"/"+example.name, func(t *testing.T) {
				s, srv := makeServer(t)
				u := inviteClient(t, s, srv, "summary-normalized-secret")
				p := basicSummaryProfile()
				p.Target = target
				p.IR.Endpoints[0].Connection.Password = example.secret
				p.IR.Endpoints[0].Name = example.label
				second := p.IR.Endpoints[0]
				second.ID = "second-node"
				second.Connection.Host = "192.0.2.11"
				p.IR.Endpoints = append(p.IR.Endpoints, second)
				p.IR.Groups[1].Members[0].Ref = second.ID
				code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
				if code != 200 {
					t.Fatal(raw)
				}
				code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "secret-labels", "name": "Labels", "profileId": p.ID})
				if code != 201 {
					t.Fatal(raw)
				}
				summary := out["routingSummary"].(map[string]any)
				if summary["chatGPT"].(map[string]any)["label"] != example.want || summary["default"].(map[string]any)["label"] != example.want+" · d411e3" {
					t.Fatal("credential base must be redacted without dropping safe collision suffix")
				}
				for _, path := range []string{"/api/me/outputs", "/api/me/outputs/secret-labels/status"} {
					code, _, raw = req(t, u.c, "GET", srv.URL+path, "", nil)
					if code != 200 {
						t.Fatal(raw)
					}
					if strings.Contains(raw, "secret,password") || strings.Contains(raw, "secret，password") || strings.Contains(raw, "secret-password") {
						t.Fatal("raw or normalized credential exposed in normal output metadata")
					}
				}
			})
		}
	}
}
