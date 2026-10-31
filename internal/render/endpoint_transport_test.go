package render_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestEndpointTransportHeadersRoundtrip(t *testing.T) {
	for _, kind := range []string{"ws", "httpupgrade"} {
		p := clientProfile()
		p.Endpoints = p.Endpoints[:1]
		p.Endpoints[0].Connection = domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: kind, Path: "/proxy", Host: "cdn.example", Headers: map[string]string{"X-Client": "fixture-only", "Authorization": "Bearer synthetic-token", "Cookie": "fixture=1", "Sec-WebSocket-Protocol": "rw-proxy"}}}
		for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
			result, err := render.DefaultClients().Render(p, target, render.NodesOnly)
			if err != nil {
				t.Fatal(err)
			}
			imported, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "u", SnapshotID: "snapshot", Format: target.AdapterID, Data: []byte(result.Artifacts[0].Content)})
			if err != nil {
				t.Fatal(err)
			}
			got := imported.Snapshot.Endpoints[0].Connection.Transport
			if got.Type != kind || got.Host != "cdn.example" || !reflect.DeepEqual(got.Headers, p.Endpoints[0].Connection.Transport.Headers) {
				t.Fatal("transport fields lost")
			}
		}
	}
}
func TestGRPCAuthorityIsTargetScoped(t *testing.T) {
	c := domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: "grpc", ServiceName: "service", Authority: "grpc.example"}}
	p := clientProfile()
	p.Endpoints = p.Endpoints[:1]
	p.Endpoints[0].Connection = c
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		if _, err := render.DefaultClients().Render(p, target, render.NodesOnly); err == nil {
			t.Fatal("unsupported authority silently dropped")
		}
	}
	ir := serverIR(render.ServerAdapterXray, render.XrayVersion)
	ir.Programs[0].Egress = []domain.Connection{c}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(artifacts[0].Content, `"authority": "grpc.example"`) {
		t.Fatal("Xray authority lost")
	}
	ir.Programs[0].Instance.AdapterID = render.ServerAdapterSingBox
	ir.Programs[0].Instance.Version = render.SingBoxVersion
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("sing-box authority silently dropped")
	}
}

func TestTransportHeaderChangesAffectPrivateSemanticSnapshot(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p := clientProfile()
		p.Endpoints[0].Connection = trojanConnection("ws")
		before, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		p.Endpoints[0].Connection.Transport.Headers["X-Client"] = "rotated-header-secret"
		after, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		a, b := before.Semantics.Nodes.Items[0], after.Semantics.Nodes.Items[0]
		if a.SettingsDigest == b.SettingsDigest || a.CategoryDigests["transport"] == b.CategoryDigests["transport"] {
			t.Fatal("header-only change missed")
		}
		for _, category := range []string{"endpoint", "protocol", "authentication", "security", "protocol-options"} {
			if a.CategoryDigests[category] != b.CategoryDigests[category] {
				t.Fatal("header changed unrelated category")
			}
		}
	}
}

func TestGRPCAuthorityRejectsServerListenerRole(t *testing.T) {
	ir := serverIR(render.ServerAdapterXray, render.XrayVersion)
	ir.Programs[0].Listener.Connection = domain.Connection{Host: "127.0.0.1", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: "grpc", ServiceName: "service", Authority: "grpc.example"}}
	if _, err := render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "GRPC_AUTHORITY_OUTBOUND_ONLY") {
		t.Fatalf("listener authority falsely promised: %v", err)
	}
	for _, adapter := range []interface {
		RenderServer(domain.ServerProgram) (any, error)
	}{render.XrayServer{}, render.SingBoxServer{}, render.ManagedXrayServer{}} {
		if _, err := adapter.RenderServer(ir.Programs[0]); err == nil || !strings.Contains(err.Error(), "GRPC_AUTHORITY_OUTBOUND_ONLY") {
			t.Fatalf("direct listener authority falsely promised: %v", err)
		}
	}
}

func TestListenerRequestHeadersRejectAtInventoryRegistryAndDirectAdapters(t *testing.T) {
	for _, protocol := range []string{"vless", "trojan", "vmess"} {
		for _, transport := range []string{"ws", "httpupgrade"} {
			for _, target := range []render.Target{{AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, {AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}, {AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}} {
				ir := serverIR(target.AdapterID, target.Version)
				p := &ir.Programs[0]
				c := trojanConnection(transport)
				if protocol != "trojan" {
					c = vmessConnection(transport, "auto")
					c.Protocol = protocol
					if protocol == "vless" {
						c.VMessSecurity = ""
					}
				}
				c.Host = "127.0.0.1"
				p.Listener.Connection = c
				if err := domain.ValidateManagedEndpoint(p.Listener); err == nil || !strings.Contains(err.Error(), "HEADERS_OUTBOUND_ONLY") {
					t.Fatalf("inventory accepted request headers: %v", err)
				}
				if _, err := render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "HEADERS_OUTBOUND_ONLY") {
					t.Fatalf("registry accepted request headers: %v", err)
				}
				var err error
				switch target.AdapterID {
				case render.ServerAdapterXray:
					_, err = (render.XrayServer{}).RenderServer(*p)
				case render.ServerAdapterSingBox:
					_, err = (render.SingBoxServer{}).RenderServer(*p)
				default:
					_, err = (render.ManagedXrayServer{}).RenderServer(*p)
				}
				if err == nil || !strings.Contains(err.Error(), "HEADERS_OUTBOUND_ONLY") {
					t.Fatalf("direct adapter could ignore/reinterpret request secret: %v", err)
				}
			}
		}
	}
}

func TestSingBoxWebSocketHostRemainsClientTemplateNotListenerEnforcement(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.SingBoxVersion)
	p := &ir.Programs[0]
	p.Listener.Connection = domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy", Host: "cdn.example"}}
	p.Egress = []domain.Connection{p.Listener.Connection}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	var tree struct {
		Inbounds []struct {
			Transport map[string]any `json:"transport"`
		} `json:"inbounds"`
		Outbounds []map[string]any `json:"outbounds"`
	}
	if json.Unmarshal([]byte(artifacts[0].Content), &tree) != nil {
		t.Fatal("invalid config")
	}
	if _, ok := tree.Inbounds[0].Transport["headers"]; ok {
		t.Fatal("listener falsely emitted unenforced Host")
	}
	tr := tree.Outbounds[0]["transport"].(map[string]any)
	if tr["headers"].(map[string]any)["Host"] != "cdn.example" {
		t.Fatal("outbound Host template lost")
	}
	route := domain.PublishedRoute{ID: "route", Path: domain.RoutePath{Entry: p.Listener.ID}, PublicHost: "127.0.0.1", PublicPort: 443}
	c, err := domain.PublicPrincipalConnection(route, p.Listener, domain.ServerPrincipal{RouteID: "route", Credential: domain.PrincipalCredential{UUID: p.Listener.Connection.UUID}})
	if err != nil || c.Transport.Host != "cdn.example" || p.Listener.Connection.Transport.Host != "cdn.example" {
		t.Fatalf("public Host template lost or input mutated: %v", err)
	}
}

func TestListenerPathsUsePortableDecodedPathContract(t *testing.T) {
	for _, transport := range []string{"ws", "httpupgrade"} {
		for _, path := range []string{"/proxy?token=fixture", "/proxy#fragment", "/proxy%2Fsegment", "/proxy%25", "/bad%"} {
			c := domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: transport, Path: path}}
			if err := domain.ValidateConnection(c); err != nil {
				t.Fatal("outbound path contract incorrectly narrowed")
			}
			endpoint := domain.ManagedEndpoint{ID: "entry", Connection: c}
			if err := domain.ValidateManagedEndpoint(endpoint); err == nil || !strings.Contains(err.Error(), "LISTENER_PATH_UNSUPPORTED") {
				t.Fatalf("listener URI path accepted: %v", err)
			}
			p := serverIR(render.ServerAdapterXray, render.XrayVersion).Programs[0]
			p.Listener.Connection = c
			for _, adapter := range []interface {
				RenderServer(domain.ServerProgram) (any, error)
			}{render.XrayServer{}, render.SingBoxServer{}, render.ManagedXrayServer{}} {
				if _, err := adapter.RenderServer(p); err == nil || !strings.Contains(err.Error(), "LISTENER_PATH_UNSUPPORTED") {
					t.Fatalf("direct listener path accepted: %v", err)
				}
			}
		}
	}
	for _, path := range []string{"", "proxy", "/proxy", "/proxy/sub"} {
		c := domain.Connection{Transport: &domain.TransportOptions{Type: "ws", Path: path}}
		if err := domain.ValidateListenerTransport(c); err != nil {
			t.Fatalf("decoded path rejected: %v", err)
		}
	}
}

func TestListenerWebSocketURIUnsafePathRejectedButHTTPUpgradeDecodedUnicodeAllowed(t *testing.T) {
	for _, path := range []string{"/路径", "/with space"} {
		c := domain.Connection{Transport: &domain.TransportOptions{Type: "ws", Path: path}}
		if domain.ValidateListenerTransport(c) == nil {
			t.Fatal("WebSocket RequestURI prefix mismatch accepted")
		}
		c.Transport.Type = "httpupgrade"
		if err := domain.ValidateListenerTransport(c); err != nil {
			t.Fatalf("decoded HTTPUpgrade path rejected: %v", err)
		}
	}
}
