package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func clientProfile() domain.ClientProfileIR {
	return domain.ClientProfileIR{SchemaVersion: "1.0", ID: "daily", Name: "Daily", OwnerID: "u", Revision: "1", Endpoints: []domain.ClientEndpoint{{ID: "uk", Name: "United Kingdom", OwnerID: "u", Origin: "imported", Connection: domain.Connection{Host: "192.0.2.10", Port: 1080, Protocol: "socks"}}, {ID: "us", Name: "United States", OwnerID: "u", Origin: "platform-entry", Connection: domain.Connection{Host: "192.0.2.20", Port: 8388, Protocol: "shadowsocks", Method: "aes-128-gcm", Password: "synthetic-fixture-secret"}}}, Groups: []domain.PolicyGroup{{ID: "manual", Name: "Choose", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "uk"}, {Kind: "endpoint", Ref: "us"}}}}, Rules: []domain.PolicyRule{{ID: "work", Match: domain.MatchExpression{Op: "domain-suffix", Value: "example.org"}, Action: domain.ActionRef{Kind: "group", Ref: "manual"}}}, DefaultAction: domain.ActionRef{Kind: "direct"}, Runtime: domain.ClientRuntime{MixedPort: 17890}}
}
func TestClientFullAndNodesOnlyAreDifferentOutputs(t *testing.T) {
	p := clientProfile()
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		full, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		nodes, err := render.DefaultClients().Render(p, target, render.NodesOnly)
		if err != nil {
			t.Fatal(err)
		}
		var fullJSON, nodesJSON map[string]any
		if err = json.Unmarshal([]byte(full.Artifacts[0].Content), &fullJSON); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal([]byte(nodes.Artifacts[0].Content), &nodesJSON); err != nil {
			t.Fatal(err)
		}
		if len(nodesJSON) != 1 {
			t.Fatalf("nodes-only included runtime/rules: %#v", nodesJSON)
		}
		if fullJSON["rules"] == nil && fullJSON["route"] == nil {
			t.Fatal("full config missing rules")
		}
		if !strings.Contains(full.Artifacts[0].Content, full.Names["manual"]) {
			t.Fatal("group references missing")
		}
		if len(full.Resources) != 0 {
			t.Fatal("invented resources")
		}
	}
}

func TestMihomoPreservesFourStrategiesAndResourceFile(t *testing.T) {
	p := clientProfile()
	p.Groups = append(p.Groups, domain.PolicyGroup{ID: "speed", Name: "Fastest", Kind: "url-test", Members: []domain.ActionRef{{Kind: "group", Ref: "manual"}}, TestURL: "https://example.org/generate_204", IntervalSeconds: 300}, domain.PolicyGroup{ID: "fail", Name: "Fallback", Kind: "fallback", Members: []domain.ActionRef{{Kind: "group", Ref: "speed"}, {Kind: "endpoint", Ref: "us"}}, TestURL: "https://example.org/generate_204", IntervalSeconds: 300}, domain.PolicyGroup{ID: "balance", Name: "Balance", Kind: "load-balance", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "uk"}, {Kind: "endpoint", Ref: "us"}}, TestURL: "https://example.org/generate_204", IntervalSeconds: 300, Strategy: "round-robin"})
	p.Resources = []domain.RuleResource{{ID: "work", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-yaml", Behavior: "classical", Location: "local", Path: "rules/work.yaml", UpdatePolicy: "pinned"}}
	p.Rules = append(p.Rules, domain.PolicyRule{ID: "file", Match: domain.MatchExpression{Op: "resource", Value: "work"}, Action: domain.ActionRef{Kind: "group", Ref: "fail"}})
	got, err := render.DefaultClients().Render(p, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{`"type": "select"`, `"type": "url-test"`, `"type": "fallback"`, `"type": "load-balance"`, `RULE-SET,work,`, `"path": "rules/work.yaml"`} {
		if !strings.Contains(got.Artifacts[0].Content, required) {
			t.Fatalf("missing %s", required)
		}
	}
	if len(got.Resources) != 1 {
		t.Fatal("file manifest missing")
	}
	if _, err = render.DefaultClients().Render(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.FullConfig); err == nil || !strings.Contains(err.Error(), "GROUP_STRATEGY_UNSUPPORTED") {
		t.Fatalf("silently changed strategy: %v", err)
	}
	if _, err = render.DefaultClients().Render(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.NodesOnly); err != nil {
		t.Fatalf("node-only export should not compile group policy: %v", err)
	}
}

func TestVLESSClientTLSRealityAndTransports(t *testing.T) {
	for _, transport := range []string{"tcp", "ws", "grpc", "httpupgrade"} {
		p := clientProfile()
		p.Endpoints[0].Connection = domain.Connection{Host: "192.0.2.30", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", ALPN: []string{"http/1.1"}}, Transport: &domain.TransportOptions{Type: transport}}
		switch transport {
		case "tcp":
			p.Endpoints[0].Connection.Flow = "xtls-rprx-vision"
			p.Endpoints[0].Connection.TLS.Reality = &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "0123456789abcdef"}
		case "ws", "httpupgrade":
			p.Endpoints[0].Connection.Transport.Path = "/proxy"
			p.Endpoints[0].Connection.Transport.Host = "cdn.example.com"
		case "grpc":
			p.Endpoints[0].Connection.Transport.ServiceName = "proxy"
		}
		for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
			got, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatalf("%s %s: %v", target.AdapterID, transport, err)
			}
			for _, s := range []string{"vless", "00000000-0000-4000-8000-000000000001", "example.com", "chrome"} {
				if !strings.Contains(got.Artifacts[0].Content, s) {
					t.Fatalf("%s %s dropped %s", target.AdapterID, transport, s)
				}
			}
		}
	}
}

type syntheticClient struct{}

func (syntheticClient) NormalizeName(name string) string { return name }

func (syntheticClient) ClientCapability() render.ClientCapability {
	return render.ClientCapability{AdapterID: "fixture/third", Versions: []string{"test-1"}, Protocols: []string{"socks", "shadowsocks"}, Groups: []string{"manual"}, MatchOps: []string{"domain-suffix"}}
}
func (syntheticClient) RenderClient(_ domain.ClientProfileIR, _ render.Target, _ render.OutputMode, names map[string]string) (render.ClientResult, error) {
	return render.ClientResult{Artifacts: []domain.Artifact{{Path: "fixture.json", Content: `{"fixture":true}`}}, Names: names}, nil
}
func TestClientRegistryAcceptsThirdNamespacedAdapterAndGatesVersions(t *testing.T) {
	registry := render.NewClients(syntheticClient{})
	if _, err := registry.Render(clientProfile(), render.Target{AdapterID: "fixture/third", Version: "test-1"}, render.FullConfig); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Render(clientProfile(), render.Target{AdapterID: "fixture/third", Version: "latest"}, render.FullConfig); err == nil {
		t.Fatal("unknown version accepted")
	}
	if err := registry.Register(syntheticClient{}); err == nil {
		t.Fatal("duplicate registration accepted")
	}
}

func TestUnknownTLSFingerprintIsNotSilentlyAccepted(t *testing.T) {
	p := clientProfile()
	p.Endpoints[0].Connection = domain.Connection{Host: "example.com", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, Fingerprint: "not-a-supported-browser"}}
	if _, err := render.DefaultClients().Render(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.FullConfig); err == nil {
		t.Fatal("unknown fingerprint compiled into invalid native output")
	}
}

func TestPublicRemoteResourceKeepsTenantOwnershipAndFileReference(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		for _, visibility := range []string{"public", "private", ""} {
			p := clientProfile()
			var resource domain.RuleResource
			if err := json.Unmarshal([]byte(`{"id":"work","ownerId":"u","visibility":"`+visibility+`","revision":"1","digest":"sha256:`+strings.Repeat("0", 64)+`","format":"sing-box-source","formatVersion":5,"location":"remote","url":"https://example.org/work.json","updatePolicy":"follow","intervalSeconds":3600}`), &resource); err != nil {
				t.Fatal(err)
			}
			if target.AdapterID == "mihomo" {
				resource.Format = "mihomo-yaml"
				resource.Behavior = "domain"
			}
			p.Resources = []domain.RuleResource{resource}
			p.Rules = []domain.PolicyRule{{ID: "file", Match: domain.MatchExpression{Op: "resource", Value: "work"}, Action: domain.ActionRef{Kind: "group", Ref: "manual"}}}
			got, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if visibility != "public" {
				if err == nil || !strings.Contains(err.Error(), "PRIVATE_RESOURCE_DELIVERY_UNSUPPORTED") {
					t.Fatalf("%s visibility %q unexpectedly delivered private file: %v", target.AdapterID, visibility, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s public owned file: %v", target.AdapterID, err)
			}
			if len(got.Resources) != 1 || got.Resources[0].OwnerID != "u" || !strings.Contains(got.Artifacts[0].Content, resource.URL) {
				t.Fatal("ownership or file reference lost")
			}
			p.Resources[0].OwnerID = "other"
			if _, err = render.DefaultClients().Render(p, target, render.FullConfig); err == nil {
				t.Fatal("public delivery bypassed tenant authorization")
			}
		}
	}
}
