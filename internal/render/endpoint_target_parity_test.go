package render_test

import (
	"crypto/ecdh"
	"encoding/base64"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestEndpointOutboundTargetParity(t *testing.T) {
	base := domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001"}
	for _, tc := range []struct {
		name, target, code string
		change             func(*domain.Connection)
	}{
		{"packet", "xray", "XRAY_PACKET_ENCODING_UNVERIFIED", func(c *domain.Connection) { c.PacketEncoding = "xudp" }},
		{"reality-alpn", "xray", "XRAY_REALITY_ALPN_UNSUPPORTED", func(c *domain.Connection) { c.TLS = parityReality(); c.TLS.ALPN = []string{"h2"} }},
		{"reality-ws", "xray", "XRAY_REALITY_TRANSPORT_UNSUPPORTED", func(c *domain.Connection) {
			c.TLS = parityReality()
			c.Transport = &domain.TransportOptions{Type: "ws", Path: "/proxy"}
		}},
		{"reality-httpupgrade", "xray", "XRAY_REALITY_TRANSPORT_UNSUPPORTED", func(c *domain.Connection) {
			c.TLS = parityReality()
			c.Transport = &domain.TransportOptions{Type: "httpupgrade", Path: "/proxy"}
		}},
		{"authority", "sing-box", "GRPC_AUTHORITY_UNSUPPORTED", func(c *domain.Connection) {
			c.Transport = &domain.TransportOptions{Type: "grpc", Authority: "grpc.example"}
		}},
		{"fingerprint", "sing-box", "TLS_FINGERPRINT_UNSUPPORTED", func(c *domain.Connection) { c.TLS = &domain.TLSOptions{Enabled: true, Fingerprint: "not-supported"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			tc.change(&c)
			n := domain.Node{ID: "node", Name: "node", Host: c.Host, Port: c.Port, Protocol: c.Protocol, UUID: c.UUID, PacketEncoding: c.PacketEncoding, TLS: c.TLS, Transport: c.Transport}
			r := domain.Route{ID: "route", Name: "route", Engine: tc.target, Hops: []string{n.ID}}
			assert := func(err error) {
				t.Helper()
				if err == nil || !strings.Contains(err.Error(), tc.code) {
					t.Fatalf("want %s, got %v", tc.code, err)
				}
			}
			_, err := render.Default().Render(r, []domain.Node{n})
			assert(err)
			var legacy render.Renderer = render.Xray{}
			var server render.ServerRenderer = render.XrayServer{}
			version := render.XrayVersion
			adapter := render.ServerAdapterXray
			if tc.target == "sing-box" {
				legacy = render.SingBox{}
				server = render.SingBoxServer{}
				version = render.SingBoxVersion
				adapter = render.ServerAdapterSingBox
			}
			_, err = legacy.Render(r, []domain.Node{n})
			assert(err)
			ir := serverIR(adapter, version)
			ir.Programs[0].Egress = []domain.Connection{c}
			_, err = render.DefaultServers().Render(ir)
			assert(err)
			p := ir.Programs[0]
			p.Egress = nil
			p.Connectors = []domain.ServerConnector{{ID: "egress", Connection: c}}
			_, err = server.RenderServer(p)
			assert(err)
		})
	}
}
func parityReality() *domain.TLSOptions {
	return &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "ab"}}
}

func TestDirectClientsRejectUnsupportedTargetOptions(t *testing.T) {
	for _, a := range []render.ClientRenderer{render.MihomoClient{}, render.SingBoxClient{}} {
		for _, code := range []string{"GRPC_AUTHORITY_UNSUPPORTED", "TLS_FINGERPRINT_UNSUPPORTED"} {
			p := clientProfile()
			p.Endpoints = p.Endpoints[:1]
			c := domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001"}
			if code == "GRPC_AUTHORITY_UNSUPPORTED" {
				c.Transport = &domain.TransportOptions{Type: "grpc", Authority: "grpc.example"}
			} else {
				c.TLS = &domain.TLSOptions{Enabled: true, Fingerprint: "not-supported"}
			}
			p.Endpoints[0].Connection = c
			_, err := a.RenderClient(p, render.Target{}, render.NodesOnly, map[string]string{p.Endpoints[0].ID: "node"})
			if err == nil || !strings.Contains(err.Error(), code) {
				t.Fatalf("%s want %s got %v", a.ClientCapability().AdapterID, code, err)
			}
		}
	}
}

func TestVMessListenerSecurityDirectAndInventoryParity(t *testing.T) {
	p := serverIR(render.ServerAdapterXray, render.XrayVersion).Programs[0]
	c := vmessConnection("tcp", "none")
	c.Host = "127.0.0.1"
	p.Listener.Connection = c
	assert := func(err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "VMESS_SECURITY_OUTBOUND_ONLY") {
			t.Fatalf("cipher omitted: %v", err)
		}
	}
	assert(domain.ValidateManagedEndpoint(p.Listener))
	for _, a := range []render.ServerRenderer{render.XrayServer{}, render.SingBoxServer{}, render.ManagedXrayServer{}} {
		_, err := a.RenderServer(p)
		assert(err)
	}
}

func TestManagedDirectRejectsNewEgressProtocols(t *testing.T) {
	for _, protocol := range []string{"trojan", "vmess"} {
		for _, legacy := range []bool{false, true} {
			p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
			c := trojanConnection("tcp")
			if protocol == "vmess" {
				c = vmessConnection("tcp", "auto")
			}
			if legacy {
				p.Egress = []domain.Connection{c}
			} else {
				p.Connectors = []domain.ServerConnector{{ID: "exit", Connection: c}}
			}
			if _, err := (render.ManagedXrayServer{}).RenderServer(p); err == nil || !strings.Contains(err.Error(), "MANAGED_EGRESS_PROTOCOL_UNSUPPORTED") {
				t.Fatalf("direct managed accepted %s: %v", protocol, err)
			}
		}
	}
}

func TestXrayListenerRealityTargetParity(t *testing.T) {
	for _, kind := range []string{"alpn", "ws", "httpupgrade"} {
		ir := serverIR(render.ServerAdapterXray, render.XrayVersion)
		p := &ir.Programs[0]
		p.Listener.Connection = domain.Connection{Host: "127.0.0.1", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: parityReality()}
		raw := make([]byte, 32)
		for i := range raw {
			raw[i] = byte(i)
		}
		key, err := ecdh.X25519().NewPrivateKey(raw)
		if err != nil {
			t.Fatal(err)
		}
		p.Listener.Connection.TLS.Reality.PublicKey = base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
		p.TLS = &domain.ServerTLSOptions{Reality: &domain.ServerRealityOptions{PrivateKey: base64.RawURLEncoding.EncodeToString(raw), HandshakeServer: "example.com", HandshakePort: 443, ServerNames: []string{"example.com"}, ShortIDs: []string{"ab"}}}
		code := "XRAY_REALITY_TRANSPORT_UNSUPPORTED"
		if kind == "alpn" {
			code = "XRAY_REALITY_ALPN_UNSUPPORTED"
			p.Listener.Connection.TLS.ALPN = []string{"h2"}
		} else {
			p.Listener.Connection.Transport = &domain.TransportOptions{Type: kind, Path: "/proxy"}
		}
		_, err = render.DefaultServers().Render(ir)
		if err == nil || !strings.Contains(err.Error(), code) {
			t.Fatalf("registry: %v", err)
		}
		_, err = (render.XrayServer{}).RenderServer(*p)
		if err == nil || !strings.Contains(err.Error(), code) {
			t.Fatalf("direct: %v", err)
		}
	}
}

func TestOutboundTargetParityPreservesValidFields(t *testing.T) {
	for _, target := range []string{"xray", "sing-box"} {
		for _, protocol := range []string{"vless", "trojan", "vmess"} {
			c := trojanConnection("httpupgrade")
			c.TLS.ALPN = []string{"http/1.1"}
			if protocol != "trojan" {
				c.Protocol = protocol
				c.Password = ""
				c.UUID = "00000000-0000-4000-8000-000000000001"
				if protocol == "vmess" {
					c.VMessSecurity = "aes-128-gcm"
				}
			}
			n := domain.Node{ID: "node", Name: "node", Host: c.Host, Port: c.Port, Protocol: c.Protocol, Password: c.Password, UUID: c.UUID, VMessSecurity: c.VMessSecurity, TLS: c.TLS, Transport: c.Transport}
			r := domain.Route{ID: "route", Name: "route", Engine: target, Hops: []string{"node"}}
			artifacts, err := render.Default().Render(r, []domain.Node{n})
			if err != nil {
				t.Fatal(err)
			}
			version, adapter := render.XrayVersion, render.ServerAdapterXray
			if target == "sing-box" {
				version, adapter = render.SingBoxVersion, render.ServerAdapterSingBox
			}
			ir := serverIR(adapter, version)
			ir.Programs[0].Egress = []domain.Connection{c}
			generic, err := render.DefaultServers().Render(ir)
			if err != nil {
				t.Fatal(err)
			}
			for _, text := range []string{artifacts[0].Content, generic[0].Content} {
				for _, value := range []string{c.Host, c.TLS.ServerName, c.TLS.Fingerprint, "http/1.1", c.Transport.Path, c.Transport.Host, c.Transport.Headers["X-Client"]} {
					if value == "" || !strings.Contains(text, value) {
						t.Fatalf("%s %s lost %q", target, protocol, value)
					}
				}
				if protocol == "vmess" && !strings.Contains(text, c.VMessSecurity) {
					t.Fatal("VMess cipher lost")
				}
			}
		}
	}
	// Native Xray's legitimate version-specific fingerprint names stay intact.
	c := domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: parityReality(), Transport: &domain.TransportOptions{Type: "grpc", ServiceName: "proxy", Authority: "grpc.example"}}
	c.TLS.Fingerprint = "chrome_120"
	n := domain.Node{ID: "node", Name: "node", Host: c.Host, Port: c.Port, Protocol: c.Protocol, UUID: c.UUID, TLS: c.TLS, Transport: c.Transport}
	artifacts, err := (render.Xray{}).Render(domain.Route{}, []domain.Node{n})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"chrome_120", "grpc.example", c.TLS.Reality.PublicKey, "ab"} {
		if !strings.Contains(artifacts[0].Content, value) {
			t.Fatalf("Xray lost %q", value)
		}
	}
}
