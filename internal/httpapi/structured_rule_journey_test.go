package httpapi_test

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// API/render composition only: no resolver queries, TUN activation or native process.
func TestStructuredRuntimeAndOwnedRuleVersionPublication(t *testing.T) {
	for _, engine := range []string{"mihomo", "sing-box"} {
		t.Run(engine, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "structured-owner")
			target := render.Target{AdapterID: engine, Version: render.MihomoVersion}
			format := "mihomo-yaml"
			body := func(name string) string { return "payload:\n  - '+." + name + ".example'\n" }
			if engine == "sing-box" {
				target.Version = render.SingBoxVersion
				format = "sing-box-source"
				body = func(name string) string { return `{"version":5,"rules":[{"domain_suffix":["` + name + `.example"]}]}` }
			}
			call := func(method, path string, data any, status int) map[string]any {
				t.Helper()
				code, value, raw := req(t, u.c, method, srv.URL+path, u.csrf, data)
				if code != status {
					t.Fatalf("%s %s: %d %s", method, path, code, raw)
				}
				return value
			}
			upload := func(name string) map[string]any {
				return call("POST", "/api/me/resources/import", map[string]any{"resource": map[string]any{"id": "owned", "format": format, "behavior": "domain", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(body(name)))}, 201)
			}
			old := upload("old")
			outputs := map[string]map[string]any{}
			frozen := map[string]map[string][]byte{}
			for _, policy := range []string{"pinned", "follow"} {
				p := templateTestProfile(policy, target)
				p.IR.Runtime = domain.ClientRuntime{MixedPort: 7890, DNS: &domain.DNSIntent{Servers: []domain.DNSResolver{{ID: "resolver", Type: "tls", Address: "192.0.2.53", Port: 853}}, Final: "resolver"}, Sniff: true, TUN: &domain.TUNIntent{Enabled: true, Addresses: []string{"172.19.0.1/30"}, AutoRoute: true}}
				p.IR.Resources = []domain.RuleResource{{ID: "owned", AcceptedVersion: old["acceptedVersion"].(string), UpdatePolicy: policy}}
				p.IR.Rules = []domain.PolicyRule{{ID: "owned-rule", Match: domain.MatchExpression{Op: "resource", Value: "owned"}, Action: domain.ActionRef{Kind: "reject"}}}
				call("POST", "/api/me/profiles", p, 200)
				if engine == "mihomo" {
					rejected := call("POST", "/api/me/profiles/"+policy+"/preview", map[string]any{}, 422)
					if !strings.Contains(rejected["detail"].(string), "RUNTIME_OPTION_UNSUPPORTED: runtime.tun") {
						t.Fatal(rejected)
					}
					p.IR.Runtime.TUN.Enabled = false
					call("PUT", "/api/me/profiles/"+policy, p, 200)
				}
				preview := call("POST", "/api/me/profiles/"+policy+"/preview", map[string]any{}, 200)
				if preview["valid"] != true {
					t.Fatalf("valid structured draft rejected: %v", preview)
				}
				outputs[policy] = call("POST", "/api/me/outputs", map[string]any{"id": policy, "name": policy, "profileId": policy}, 201)
				frozen[policy] = downloadBundle(t, u.c, srv.URL+outputs[policy]["downloadPath"].(string))
				var config map[string]any
				if err := json.Unmarshal(frozen[policy][engine+".json"], &config); err != nil {
					t.Fatal(err)
				}
				if config["dns"] == nil {
					t.Fatal("structured DNS missing")
				}
				if engine == "mihomo" {
					if config["sniffer"] == nil {
						t.Fatal("structured TUN/sniff omitted")
					}
				} else {
					raw, _ := json.Marshal(config)
					if !strings.Contains(string(raw), `"type":"tun"`) || !strings.Contains(string(raw), `"action":"sniff"`) {
						t.Fatal("structured TUN/sniff omitted", string(raw))
					}
				}
			}
			stale := call("POST", "/api/me/profiles/follow/preview", map[string]any{"outputId": "follow"}, 200)
			next := upload("new")
			call("POST", "/api/me/outputs/follow/publish", map[string]any{"previewDigest": stale["previewDigest"]}, 409)
			for _, policy := range []string{"pinned", "follow"} {
				if !reflect.DeepEqual(downloadBundle(t, u.c, srv.URL+outputs[policy]["downloadPath"].(string)), frozen[policy]) {
					t.Fatal("resource update or rejected publication mutated frozen output", policy)
				}
			}
			for _, policy := range []string{"pinned", "follow"} {
				review := call("POST", "/api/me/profiles/"+policy+"/preview", map[string]any{"outputId": policy}, 200)
				call("POST", "/api/me/outputs/"+policy+"/publish", map[string]any{"previewDigest": review["previewDigest"]}, 200)
				files := downloadBundle(t, u.c, srv.URL+outputs[policy]["downloadPath"].(string))
				expected := old
				name := "old"
				if policy == "follow" {
					expected = next
					name = "new"
				}
				if string(files[expected["path"].(string)]) != body(name) {
					t.Fatalf("%s resource version not preserved", policy)
				}
				if policy == "pinned" && !reflect.DeepEqual(downloadBundle(t, u.c, srv.URL+outputs["follow"]["downloadPath"].(string)), frozen["follow"]) {
					t.Fatal("sibling output changed")
				}
			}
		})
	}
}
