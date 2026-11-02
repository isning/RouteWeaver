package httpapi_test

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// E06 joins accepted source membership, nested policy, review and two frozen
// feeds through public HTTP seams. It never starts a client or probes TestURL.
func TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication(t *testing.T) {
	for _, kind := range []string{"manual", "url-test", "fallback", "load-balance"} {
		t.Run(kind, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "nested-source-owner")
			call := func(method, path string, body any, want int) map[string]any {
				t.Helper()
				code, value, raw := req(t, u.c, method, srv.URL+"/api/me"+path, u.csrf, body)
				if code != want {
					t.Fatalf("%s %s: %d %s", method, path, code, raw)
				}
				return value
			}
			source := map[string]any{"id": "airport", "name": "Airport", "kind": "text", "content": "socks5://one.example:1080#One", "enabled": true}
			accepted := call("POST", "/sources", source, 200)
			firstSnapshot := sourceSnapshotID(t, accepted)
			leaf := domain.PolicyGroup{ID: "leaf", Name: "Dynamic leaf", Kind: kind, Members: []domain.ActionRef{{Kind: "direct"}}, Dynamic: &domain.EndpointFilter{SourceID: "airport"}}
			if kind != "manual" {
				leaf.TestURL, leaf.IntervalSeconds = "https://probe.example/generate_204", 300
			}
			if kind == "load-balance" {
				leaf.Strategy = "round-robin"
			}
			p := httpapi.Profile{ID: "nested", Name: "Nested policy", SourceIDs: []string{"airport"}, Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, IR: domain.ClientProfileIR{
				SchemaVersion: "1.0",
				Groups: []domain.PolicyGroup{leaf,
					{ID: "middle", Name: "Middle", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "leaf"}}},
					{ID: "root", Name: "Root", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "middle"}}}},
				DefaultAction: domain.ActionRef{Kind: "group", Ref: "root"},
			}}
			call("POST", "/profiles", p, 200)
			savedRecipe := call("GET", "/profiles/nested/reveal", nil, 200)["ir"]
			outputs := map[string]map[string]any{}
			for _, id := range []string{"chosen", "sibling"} {
				outputs[id] = call("POST", "/outputs", map[string]any{"id": id, "name": id, "profileId": p.ID}, 201)
			}
			feed := func(id string) string {
				t.Helper()
				code, _, raw := req(t, http.DefaultClient, "GET", srv.URL+outputs[id]["feedPath"].(string), "", nil)
				if code != 200 {
					t.Fatalf("%s feed: %d %s", id, code, raw)
				}
				return raw
			}
			before := feed("chosen")
			if feed("sibling") != before {
				t.Fatal("fixture publications differ")
			}
			assertPolicy := func(content string, members []any) {
				t.Helper()
				var config map[string]any
				if err := json.Unmarshal([]byte(content), &config); err != nil {
					t.Fatal(err)
				}
				groups := map[string]map[string]any{}
				for _, value := range config["proxy-groups"].([]any) {
					g := value.(map[string]any)
					groups[g["name"].(string)] = g
				}
				wantKind := kind
				if wantKind == "manual" {
					wantKind = "select"
				}
				if len(groups) != 3 || groups["Dynamic leaf"]["type"] != wantKind || !reflect.DeepEqual(groups["Dynamic leaf"]["proxies"], members) ||
					!reflect.DeepEqual(groups["Middle"]["proxies"], []any{"Dynamic leaf"}) || !reflect.DeepEqual(groups["Root"]["proxies"], []any{"Middle"}) ||
					groups["Middle"]["type"] != "select" || groups["Root"]["type"] != "select" || !reflect.DeepEqual(config["rules"], []any{"MATCH,Root"}) {
					t.Fatalf("strategy, additive membership, depth or default changed: %s", content)
				}
				if kind != "manual" && (groups["Dynamic leaf"]["url"] != leaf.TestURL || groups["Dynamic leaf"]["interval"] != float64(300)) {
					t.Fatal("test policy changed")
				}
				if kind == "load-balance" && groups["Dynamic leaf"]["strategy"] != "round-robin" {
					t.Fatal("balance policy changed")
				}
			}
			assertPolicy(before, []any{"DIRECT", "One"})
			source["content"] = "socks5://one.example:1080#One\nsocks5://two.example:1080#Two"
			updated := call("PUT", "/sources/airport", source, 200)
			if updated["candidate"] != nil || sourceSnapshotID(t, updated) == firstSnapshot {
				t.Fatal("harmless source addition did not become accepted membership")
			}
			review := call("POST", "/profiles/nested/preview", map[string]any{"outputId": "chosen"}, 200)
			if review["valid"] != true || semanticCategory(t, review, "groups")["changedCount"] != float64(1) {
				t.Fatal("review must identify exactly the changed dynamic leaf")
			}
			row := semanticCategory(t, review, "groups")["rows"].([]any)[0].(map[string]any)
			if row["strategyChanged"] != false || len(row["membersAdded"].([]any)) != 1 || row["membersAdded"].([]any)[0].(map[string]any)["label"] != "Two" {
				t.Fatalf("membership change review is inaccurate: %#v", row)
			}
			previewContent := review["artifacts"].([]any)[0].(map[string]any)["content"].(string)
			assertPolicy(previewContent, []any{"DIRECT", "One", "Two"})
			for _, id := range []string{"chosen", "sibling"} {
				if feed(id) != before || call("GET", "/outputs/"+id+"/status", nil, 200)["draftComparison"].(map[string]any)["state"] != "changed" {
					t.Fatal("source acceptance or preview silently republished a feed")
				}
			}
			if kind == "fallback" || kind == "load-balance" {
				unsupported := call("POST", "/profiles/nested/preview", map[string]any{"target": render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, "mode": "full"}, 422)
				if unsupported["detail"] != "GROUP_STRATEGY_UNSUPPORTED: groups[0] target cannot preserve "+kind || unsupported["artifacts"] != nil {
					t.Fatal("adapter must reject the exact unpreservable strategy without a substitute artifact")
				}
				if feed("chosen") != before || feed("sibling") != before {
					t.Fatal("unsupported adapter preview changed a publication")
				}
			}
			// Redacted preview reserializes JSON without the renderer's trailing newline.
			// This credential-free fixture expects exactly that JSON plus one newline.
			published := call("POST", "/outputs/chosen/publish", map[string]any{"previewDigest": review["previewDigest"]}, 200)
			if published["revision"] == outputs["chosen"]["revision"] || feed("chosen") != previewContent+"\n" || feed("sibling") != before {
				t.Fatal("explicit publication failed reviewed JSON plus emitted newline, or sibling/token isolation")
			}
			if !reflect.DeepEqual(savedRecipe, call("GET", "/profiles/nested/reveal", nil, 200)["ir"]) {
				t.Fatal("membership resolution or publication rewrote the saved dynamic recipe")
			}
			if call("GET", "/outputs/chosen/status", nil, 200)["draftComparison"].(map[string]any)["state"] != "unchanged" ||
				call("GET", "/outputs/sibling/status", nil, 200)["draftComparison"].(map[string]any)["state"] != "changed" {
				t.Fatal("publication advanced the wrong comparison baseline")
			}
		})
	}
}
