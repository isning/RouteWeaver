package httpapi_test

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestAnyTLSSourceImportsPublishesAndKeepsCredentialsOwnerScoped(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "anytls-owner")
	other := inviteClient(t, s, srv, "anytls-other")
	const password = "synthetic:p@ss/word"
	const uri = "anytls://synthetic%3Ap%40ss%2Fword@proxy.example?sni=tls.example#Tokyo%20%E8%8A%82%E7%82%B9"
	source := map[string]any{"id": "anytls-source", "name": "Private AnyTLS", "kind": "text", "format": "uri-list", "content": uri, "enabled": true}
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, source)
	var accepted httpapi.Source
	if code != 200 || json.Unmarshal([]byte(raw), &accepted) != nil || accepted.Snapshot == nil || len(accepted.Snapshot.Endpoints) != 1 {
		t.Fatalf("import AnyTLS URI: %d %s", code, raw)
	}
	endpointID := accepted.Snapshot.Endpoints[0].ID
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/sources/anytls-source/reveal", "", nil)
	var revealed httpapi.Source
	if code != 200 || json.Unmarshal([]byte(raw), &revealed) != nil || revealed.Snapshot == nil || len(revealed.Snapshot.Endpoints) != 1 {
		t.Fatalf("owner reveal: %d %s", code, raw)
	}
	endpoint := revealed.Snapshot.Endpoints[0]
	expected := domain.Connection{Protocol: "anytls", Host: "proxy.example", Port: 443, Password: password, TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls.example"}}
	if endpoint.Name != "Tokyo 节点" || !reflect.DeepEqual(endpoint.Connection, expected) {
		t.Fatalf("import changed decoded name, default port or connection: %#v", endpoint)
	}
	for _, path := range []string{"/api/me/sources", "/api/me/sources/anytls-source"} {
		code, _, raw = req(t, owner.c, "GET", srv.URL+path, "", nil)
		if code != 200 || strings.Contains(raw, password) || strings.Contains(raw, "synthetic%3A") {
			t.Fatalf("source summary leaked credentials: %d %s", code, raw)
		}
	}
	for _, path := range []string{"/api/me/sources/anytls-source", "/api/me/sources/anytls-source/reveal"} {
		code, _, raw = req(t, other.c, "GET", srv.URL+path, "", nil)
		if code != 404 || strings.Contains(raw, password) {
			t.Fatalf("other user accessed source: %d %s", code, raw)
		}
	}
	profile := httpapi.Profile{ID: "anytls-profile", Name: "AnyTLS", Target: render.Target{AdapterID: "sing-box", Version: "1.14.3"}, Mode: render.FullConfig, SourceIDs: []string{"anytls-source"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: endpointID}}}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile)
	if code != 200 {
		t.Fatalf("save profile: %d %s", code, raw)
	}
	code, preview, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles/anytls-profile/preview", owner.csrf, map[string]any{"target": profile.Target, "mode": "full"})
	if code != 200 || preview["valid"] != true {
		t.Fatalf("preview: %d %s", code, raw)
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || strings.TrimSpace(raw) != "[]" {
		t.Fatalf("preview published unexpectedly: %d %s", code, raw)
	}
	code, output, raw := req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "anytls-output", "name": "AnyTLS", "profileId": profile.ID, "target": profile.Target, "mode": "full"})
	if code != 201 {
		t.Fatalf("publish: %d %s", code, raw)
	}
	feedPath, ok := output["feedPath"].(string)
	if !ok {
		t.Fatal("published output missing feed path")
	}
	code, config, raw := req(t, http.DefaultClient, "GET", srv.URL+feedPath, "", nil)
	if code != 200 {
		t.Fatalf("feed: %d %s", code, raw)
	}
	outbounds, ok := config["outbounds"].([]any)
	if !ok {
		t.Fatalf("feed missing outbounds: %s", raw)
	}
	found := 0
	for _, value := range outbounds {
		outbound, ok := value.(map[string]any)
		if !ok || outbound["type"] != "anytls" {
			continue
		}
		found++
		expectedOutbound := map[string]any{"type": "anytls", "tag": "Tokyo 节点", "server": "proxy.example", "server_port": float64(443), "password": password, "tls": map[string]any{"enabled": true, "server_name": "tls.example"}}
		if !reflect.DeepEqual(outbound, expectedOutbound) {
			t.Fatalf("published AnyTLS connection differs: %#v", outbound)
		}
	}
	if found != 1 {
		t.Fatalf("expected one AnyTLS outbound, got %d", found)
	}
}
