package render_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func stockDestinationProgram(protocol string) domain.ServerDeploymentIR {
	ir := serverIR(render.ServerAdapterXray, render.StockXrayVersion)
	p := &ir.Programs[0]
	p.Listener.Connection = domain.Connection{Host: "127.0.0.1", Port: 18080, Protocol: protocol}
	switch protocol {
	case "vless", "vmess":
		p.Listener.Connection.UUID = "00000000-0000-4000-8000-000000000001"
	case "trojan":
		p.Listener.Connection.Password = "synthetic-only"
		p.Listener.Connection.TLS = &domain.TLSOptions{Enabled: true}
		p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem"}
	case "shadowsocks":
		p.Listener.Connection.Method = "aes-128-gcm"
		p.Listener.Connection.Password = "synthetic-only"
	case "socks":
		p.Listener.Connection.Username = "fixture"
		p.Listener.Connection.Password = "synthetic-only"
	}
	return ir
}

func stockDirectSettings(t *testing.T, artifacts []domain.Artifact) map[string]any {
	t.Helper()
	var config struct{ Outbounds []map[string]any }
	if err := json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
		t.Fatal(err)
	}
	var direct map[string]any
	for _, outbound := range config.Outbounds {
		if outbound["tag"] == "rw-direct" {
			direct = outbound["settings"].(map[string]any)
		} else if settings, ok := outbound["settings"].(map[string]any); ok && settings["finalRules"] != nil {
			t.Fatal("destination exceptions leaked to connector or reject outbound")
		}
	}
	if direct == nil {
		t.Fatal("missing direct outbound")
	}
	return direct
}

func TestStockXrayDestinationPolicyMapsOnlyExplicitExceptions(t *testing.T) {
	for _, protocol := range []string{"vless", "vmess", "trojan", "shadowsocks"} {
		t.Run(protocol, func(t *testing.T) {
			ir := stockDestinationProgram(protocol)
			ir.Programs[0].DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32", "fd12:3456::/48"}}
			artifacts, err := render.DefaultServers().Render(ir)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"finalRules": []any{
				map[string]any{"action": "allow", "ip": []any{"127.0.0.1/32"}},
				map[string]any{"action": "allow", "ip": []any{"fd12:3456::/48"}},
			}}
			if got := stockDirectSettings(t, artifacts); !reflect.DeepEqual(got, want) {
				t.Fatalf("exceptions altered scope or default policy: %#v", got)
			}
		})
	}
}

func TestStockXrayDestinationPolicyOmissionPreservesUpstreamDefaults(t *testing.T) {
	for _, protocol := range []string{"vless", "vmess", "trojan", "shadowsocks"} {
		for _, policy := range []*domain.DestinationPolicy{nil, {}} {
			ir := stockDestinationProgram(protocol)
			ir.Programs[0].DestinationPolicy = policy
			artifacts, err := render.DefaultServers().Render(ir)
			if err != nil {
				t.Fatal(err)
			}
			if got := stockDirectSettings(t, artifacts); len(got) != 0 {
				t.Fatalf("missing exceptions altered upstream defaults: %#v", got)
			}
		}
	}
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	p.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "managed", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
	if err != nil {
		t.Fatal(err)
	}
	if len(stockDirectSettings(t, artifacts)) != 0 || !strings.Contains(artifacts[1].Content, "127.0.0.1/32") {
		t.Fatal("stock finalRules leaked into managed embedded core or replaced its policy")
	}
}

func TestStockDestinationPolicyRejectsUnsupportedTargetsAndUnsafeCIDRs(t *testing.T) {
	for _, target := range []struct{ adapter, version, protocol string }{
		{render.ServerAdapterXray, render.HistoricalStockXrayVersion, "vless"},
		{render.ServerAdapterSingBox, render.StockSingBoxVersion, "vless"},
		{render.ServerAdapterSingBox, render.HistoricalStockSingBoxVersion, "vless"},
		{render.ServerAdapterXray, render.StockXrayVersion, "socks"},
	} {
		ir := stockDestinationProgram(target.protocol)
		ir.Programs[0].Instance.AdapterID = target.adapter
		ir.Programs[0].Instance.Version = target.version
		ir.Programs[0].DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
		if _, err := render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "SERVER_DESTINATION_POLICY_UNVERIFIED") {
			t.Fatalf("unsupported target accepted destination policy: %+v %v", target, err)
		}
	}
	for _, cidrs := range [][]string{{"0.0.0.0/0"}, {"::/0"}, {"127.0.0.1/8"}, {"invalid"}, {"127.0.0.1/32", "127.0.0.1/32"}} {
		ir := stockDestinationProgram("vless")
		ir.Programs[0].DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: cidrs}
		if _, err := render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "unique canonical non-default CIDRs") {
			t.Fatalf("invalid destination exceptions accepted: %v %v", cidrs, err)
		}
	}
}
