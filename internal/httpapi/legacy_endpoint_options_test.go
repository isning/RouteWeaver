package httpapi_test

import (
	"routeweaver/internal/domain"
	"strings"
	"testing"
)

func TestLegacyEndpointEditorPreservesTypedOptionsAndRouteIdentity(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	tenant := inviteClient(t, s, srv, "legacy-endpoint-reader")
	for _, protocol := range []string{"vless", "trojan", "vmess"} {
		node := domain.Node{ID: "typed-" + protocol, Name: "Typed endpoint", Host: "proxy.example", Port: 443, Protocol: protocol, TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls.example"}, Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy", Host: "cdn.example", Headers: map[string]string{"X-Token": "synthetic-header-secret"}}}
		if protocol == "trojan" {
			node.Password = "synthetic-trojan-secret"
		} else {
			node.UUID = "00000000-0000-4000-8000-000000000001"
		}
		if protocol == "vmess" {
			node.VMessSecurity = "chacha20-poly1305"
		}
		code, _, raw := req(t, admin, "POST", srv.URL+"/api/nodes", "", node)
		if code != 200 && code != 201 {
			t.Fatalf("save %d %s", code, raw)
		}
		route := domain.Route{ID: "route-" + protocol, Name: "Typed route", Engine: "sing-box", Hops: []string{node.ID}}
		code, _, raw = req(t, admin, "POST", srv.URL+"/api/routes", "", route)
		if code != 200 && code != 201 {
			t.Fatalf("route %d %s", code, raw)
		}
		node.Name = "Renamed endpoint"
		node.Transport.Headers["X-Token"] = "rotated-header-secret"
		code, _, raw = req(t, admin, "PUT", srv.URL+"/api/nodes/"+node.ID, "", node)
		if code != 200 {
			t.Fatalf("update %d %s", code, raw)
		}
		state, err := s.State()
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, saved := range state.Nodes {
			if saved.ID == node.ID {
				found = true
				if saved.Transport.Headers["X-Token"] != "rotated-header-secret" || saved.VMessSecurity != node.VMessSecurity || saved.UUID != node.UUID || saved.Password != node.Password {
					t.Fatal("stored options lost")
				}
			}
		}
		if !found {
			t.Fatal("identity lost")
		}
		code, out, raw := req(t, admin, "POST", srv.URL+"/api/routes/"+route.ID+"/validate", "", nil)
		if code != 200 || out["valid"] != true || !strings.Contains(raw, "rotated-header-secret") {
			t.Fatalf("typed route render %d %s", code, raw)
		}
	}
	for _, path := range []string{"/api/state", "/api/nodes"} {
		method := "GET"
		var body any
		if path == "/api/nodes" {
			method = "POST"
			body = domain.Node{ID: "forbidden"}
		}
		code, _, _ := req(t, tenant.c, method, srv.URL+path, tenant.csrf, body)
		if code != 403 {
			t.Fatalf("tenant legacy access %s: %d", path, code)
		}
	}
}

func TestListenerInventoryRejectsRequestOptionsBeforePersistence(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	instance := domain.CoreInstance{ID: "listener-core", HostID: "host", AdapterID: "routeweaver/sing-box", Version: "1.14.3"}
	if err := s.Put("core-instances", instance.ID, instance); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*domain.TransportOptions{{Type: "ws", Headers: map[string]string{"Authorization": "synthetic-request-secret"}}, {Type: "grpc", Authority: "grpc.example"}, {Type: "ws", Path: "/proxy?token=fixture"}} {
		endpoint := domain.ManagedEndpoint{ID: "invalid-listener", InstanceID: instance.ID, Name: "Listener", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", Transport: transport}}
		code, _, raw := req(t, admin, "POST", srv.URL+"/api/managed-endpoints", "", endpoint)
		if code != 400 || strings.Contains(raw, "synthetic-request-secret") {
			t.Fatalf("invalid listener save or secret error %d %s", code, raw)
		}
		var saved domain.ManagedEndpoint
		if err := s.Get("managed-endpoints", endpoint.ID, &saved); err == nil {
			t.Fatal("invalid listener persisted")
		}
	}
}

func TestHysteria2InventoryTargetAndSecretRoundtrip(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	for _, protocol := range []string{"hysteria2", "anytls"} {
		for _, target := range []struct {
			adapter, version string
			valid            bool
		}{
			{"routeweaver/sing-box", "1.14.3", true}, {"routeweaver/sing-box", "1.14.4", true},
			{"routeweaver/xray", "26.10.31", false}, {"routeweaver/sing-box", "0.0.0", false},
		} {
			instance := domain.CoreInstance{ID: "hy2-core", HostID: "host", AdapterID: target.adapter, Version: target.version}
			if err := s.Put("core-instances", instance.ID, instance); err != nil {
				t.Fatal(err)
			}
			endpoint := domain.ManagedEndpoint{ID: protocol + "-" + strings.ReplaceAll(target.version, ".", "-"), InstanceID: instance.ID, Name: "Hysteria2", Connection: domain.Connection{Protocol: protocol, Host: "127.0.0.1", Port: 443, Password: "synthetic-hy2-secret", TLS: &domain.TLSOptions{Enabled: true, ServerName: "proxy.example"}}}
			code, _, raw := req(t, admin, "POST", srv.URL+"/api/managed-endpoints", "", endpoint)
			if target.valid {
				if code != 200 && code != 201 {
					t.Fatalf("valid save %d %s", code, raw)
				}
				var saved domain.ManagedEndpoint
				if err := s.Get("managed-endpoints", endpoint.ID, &saved); err != nil {
					t.Fatal(err)
				}
				if saved.Connection.Password != endpoint.Connection.Password || saved.Connection.TLS.ServerName != "proxy.example" {
					t.Fatal("HY2 data lost")
				}
			} else if code != 400 {
				t.Fatalf("unsupported core accepted %d %s", code, raw)
			}
			if strings.Contains(raw, endpoint.Connection.Password) {
				t.Fatal("save response leaked password")
			}
		}
	}
}
