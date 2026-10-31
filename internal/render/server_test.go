package render_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func serverIR(adapter, version string) domain.ServerDeploymentIR {
	return domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", TopologyRevision: "1", Programs: []domain.ServerProgram{{Instance: domain.CoreInstance{ID: "instance", HostID: "host", AdapterID: adapter, Version: version}, Listener: domain.ManagedEndpoint{ID: "entry", InstanceID: "instance", Name: "Entry", Connection: domain.Connection{Host: "127.0.0.1", Port: 18080, Protocol: "socks", Username: "test-user", Password: "synthetic-only"}}, Egress: []domain.Connection{{Host: "192.0.2.10", Port: 1080, Protocol: "socks"}, {Host: "192.0.2.20", Port: 1080, Protocol: "socks"}, {Host: "192.0.2.30", Port: 8388, Protocol: "shadowsocks", Method: "aes-128-gcm", Password: "synthetic-only"}}}}}
}
func TestServerRendererSeparatesProgramsAndNeverUsesClientListener(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, {AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}} {
		artifacts, err := render.DefaultServers().Render(serverIR(target.AdapterID, target.Version))
		if err != nil {
			t.Fatal(err)
		}
		if len(artifacts) != 1 || artifacts[0].Path != "instance/config.json" {
			t.Fatalf("wrong per-instance artifact %#v", artifacts)
		}
		if !strings.Contains(artifacts[0].Content, "18080") || strings.Contains(artifacts[0].Content, "10808") {
			t.Fatal("server program substituted client loopback listener")
		}
		if !strings.Contains(artifacts[0].Content, "synthetic-only") {
			t.Fatal("auth omitted")
		}
	}
}

func TestServerPolicyUsesStableConnectorAndPreservesRules(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.SingBoxVersion)
	p := &ir.Programs[0]
	p.Egress = nil
	p.Connectors = []domain.ServerConnector{{ID: "entry-proxy", Connection: domain.Connection{Host: "192.0.2.1", Port: 1080, Protocol: "socks"}}, {ID: "uk-exit", Via: "entry-proxy", Connection: domain.Connection{Host: "192.0.2.2", Port: 1080, Protocol: "socks"}}}
	p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "uk-exit"}
	p.Rules = []domain.PolicyRule{{ID: "reject", Match: domain.MatchExpression{Op: "domain", Value: "blocked.example"}, Action: domain.ActionRef{Kind: "reject"}}, {ID: "direct", Match: domain.MatchExpression{Op: "domain-suffix", Value: "local.example"}, Action: domain.ActionRef{Kind: "direct"}}}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{`"detour": "entry-proxy"`, `"final": "uk-exit"`, `"domain": [`, `"action": "reject"`} {
		if !strings.Contains(artifacts[0].Content, part) {
			t.Fatalf("lost policy: %s", part)
		}
	}
	p.Connectors[0].Via = "uk-exit"
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("connector cycle accepted")
	}
}
