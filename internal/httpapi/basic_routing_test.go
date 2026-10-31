package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// This fixture mirrors the bounded task's public profile shape, not a private UI
// helper. It exercises the real save/preview/publication/render seams offline.
func TestBasicRoutingSetupUsesEntitledRouteAndPrivateDefault(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "basic-routing")
	if err := s.Put("routes", "route", domain.Route{ID: "route", Name: "FRA → UK", UserIDs: []string{user.id}}); err != nil {
		t.Fatal(err)
	}
	grant := httpapi.PublicEntryGrant{ID: "entry", Name: "FRA → UK", RouteID: "route", CredentialVersion: "v1", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.10", Port: 1080}}
	code, _, raw := req(t, operatorClient(), "POST", srv.URL+"/api/users/"+user.id+"/entries", "", grant)
	if code != 201 {
		t.Fatalf("grant: %d %s", code, raw)
	}
	source := map[string]any{"id": "airport", "name": "My airport", "kind": "text", "format": "uri-list", "content": "socks5://192.0.2.20:1080#Tokyo", "enabled": true}
	code, _, raw = req(t, user.c, "POST", srv.URL+"/api/me/sources", user.csrf, source)
	var accepted httpapi.Source
	if code != 200 || json.Unmarshal([]byte(raw), &accepted) != nil || accepted.Snapshot == nil || len(accepted.Snapshot.Endpoints) != 1 {
		t.Fatalf("source: %d %s", code, raw)
	}
	endpoint := accepted.Snapshot.Endpoints[0].ID
	p := httpapi.Profile{ID: "basic-profile", Name: "Daily", Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, SourceIDs: []string{"airport"}, PlatformEntryIDs: []string{"entry"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", Groups: []domain.PolicyGroup{{ID: "basic_chatgpt", Name: "ChatGPT", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "entry"}}}, {ID: "basic_default", Name: "其他流量", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: endpoint}}}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "basic_default"}}}
	for i, domainName := range []string{"chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"} {
		p.IR.Rules = append(p.IR.Rules, domain.PolicyRule{ID: []string{"basic_chatgpt_0", "basic_chatgpt_1", "basic_chatgpt_2", "basic_chatgpt_3"}[i], Match: domain.MatchExpression{Op: "domain-suffix", Value: domainName}, Action: domain.ActionRef{Kind: "group", Ref: "basic_chatgpt"}})
	}
	code, _, raw = req(t, user.c, "POST", srv.URL+"/api/me/profiles", user.csrf, p)
	if code != 200 {
		t.Fatalf("save: %d %s", code, raw)
	}
	code, preview, raw := req(t, user.c, "POST", srv.URL+"/api/me/profiles/basic-profile/preview", user.csrf, map[string]any{"target": p.Target, "mode": "full"})
	if code != 200 || preview["valid"] != true {
		t.Fatalf("preview: %d %s", code, raw)
	}
	_, _, raw = req(t, user.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if strings.TrimSpace(raw) != "[]" {
		t.Fatalf("preview published output: %s", raw)
	}
	code, output, raw := req(t, user.c, "POST", srv.URL+"/api/me/outputs", user.csrf, map[string]any{"id": "basic-output", "name": "Daily", "profileId": p.ID, "target": p.Target, "mode": "full"})
	if code != 201 {
		t.Fatalf("publish: %d %s", code, raw)
	}
	code, config, before := req(t, http.DefaultClient, "GET", srv.URL+output["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatalf("feed: %d %s", code, before)
	}
	groups, ok := config["proxy-groups"].([]any)
	if !ok {
		t.Fatalf("missing groups: %s", before)
	}
	members := map[string]any{}
	for _, group := range groups {
		g := group.(map[string]any)
		members[g["name"].(string)] = g["proxies"]
	}
	selected, _ := json.Marshal(members)
	if string(selected) != `{"ChatGPT":["FRA → UK"],"其他流量":["Tokyo"]}` {
		t.Fatalf("routing selection changed: %s", selected)
	}
	if !strings.Contains(before, "DOMAIN-SUFFIX,chatgpt.com,ChatGPT") || !strings.Contains(before, "MATCH,其他流量") {
		t.Fatalf("routing rules/default missing: %s", before)
	}
	source["enabled"] = false
	code, _, raw = req(t, user.c, "PUT", srv.URL+"/api/me/sources/airport", user.csrf, source)
	if code != 200 {
		t.Fatalf("disable source: %d %s", code, raw)
	}
	code, _, _ = req(t, user.c, "POST", srv.URL+"/api/me/profiles/basic-profile/preview", user.csrf, map[string]any{"outputId": "basic-output"})
	if code != 422 {
		t.Fatalf("unavailable source preview succeeded: %d", code)
	}
	code, _, after := req(t, http.DefaultClient, "GET", srv.URL+output["feedPath"].(string), "", nil)
	if code != 200 || after != before {
		t.Fatal("failed draft preview changed published subscription")
	}
}
