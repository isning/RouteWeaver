package domain_test

import (
	"testing"

	"routeweaver/internal/domain"
)

func TestPublishedPublicVLESSRequiresTLS(t *testing.T) {
	for _, host := range []string{"entry.example", "localhost", "8.8.8.8", "2001:4860:4860::8888", "169.254.169.254", "0.0.0.0", "::"} {
		t.Run(host, func(t *testing.T) {
			route := domain.PublishedRoute{PublicHost: host}
			if err := domain.ValidatePublishedEntrySecurity(route, domain.Connection{Protocol: "vless"}); err == nil {
				t.Fatal("unencrypted public or ambiguous entry accepted")
			}
			if err := domain.ValidatePublishedEntrySecurity(route, domain.Connection{Protocol: "vless", TLS: &domain.TLSOptions{Enabled: true}}); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, host := range []string{"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "fd00::1"} {
		if err := domain.ValidatePublishedEntrySecurity(domain.PublishedRoute{PublicHost: host}, domain.Connection{Protocol: "vless"}); err != nil {
			t.Fatalf("explicit internal entry %s: %v", host, err)
		}
	}
}

func TestDestinationExceptionsRequireCanonicalBoundedCIDRs(t *testing.T) {
	for _, cidrs := range [][]string{{"0.0.0.0/0"}, {"::/0"}, {"127.0.0.1/8"}, {"localhost"}, {"127.0.0.1/32", "127.0.0.1/32"}} {
		if err := domain.ValidateDestinationPolicy(&domain.DestinationPolicy{AllowCIDRs: cidrs}); err == nil {
			t.Fatalf("invalid destination exceptions accepted: %v", cidrs)
		}
	}
	if err := domain.ValidateDestinationPolicy(&domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32", "::1/128"}}); err != nil {
		t.Fatal(err)
	}
}

func TestManagedPrincipalListenerRemainsCredentialFree(t *testing.T) {
	endpoint := domain.ManagedEndpoint{
		ID: "entry", InstanceID: "core", Name: "Renamed public listener", Authentication: "principals",
		Connection: domain.Connection{Host: "0.0.0.0", Port: 443, Protocol: "vless", TLS: &domain.TLSOptions{Enabled: true, ServerName: "entry.example.com"}},
	}
	if err := domain.ValidateManagedEndpoint(endpoint); err != nil {
		t.Fatalf("credential-free principal listener: %v", err)
	}
	for _, field := range []string{"uuid", "flow", "username", "password", "method", "protocol"} {
		t.Run(field, func(t *testing.T) {
			invalid := endpoint
			switch field {
			case "uuid":
				invalid.Connection.UUID = "00000000-0000-4000-8000-000000000001"
			case "flow":
				invalid.Connection.Flow = "xtls-rprx-vision"
			case "username":
				invalid.Connection.Username = "shared"
			case "password":
				invalid.Connection.Password = "fixture"
			case "method":
				invalid.Connection.Method = "aes-128-gcm"
			case "protocol":
				invalid.Connection.Protocol = "socks"
			}
			if err := domain.ValidateManagedEndpoint(invalid); err == nil {
				t.Fatalf("principal listener accepted shared credential or non-VLESS protocol: %s", field)
			}
		})
	}
	endpoint.Authentication = ""
	if err := domain.ValidateManagedEndpoint(endpoint); err == nil {
		t.Fatal("legacy VLESS listener accepted without a UUID")
	}
	endpoint.Connection.UUID = "00000000-0000-4000-8000-000000000001"
	if err := domain.ValidateManagedEndpoint(endpoint); err != nil {
		t.Fatalf("legacy VLESS listener with UUID: %v", err)
	}
}

func TestPrincipalProjectionRejectsListenerRequestHeaders(t *testing.T) {
	listener := domain.ManagedEndpoint{ID: "entry", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 443, Transport: &domain.TransportOptions{Type: "ws", Headers: map[string]string{"Authorization": "synthetic-header-secret"}}}}
	route := domain.PublishedRoute{ID: "route", Path: domain.RoutePath{Entry: "entry"}, PublicHost: "public.example", PublicPort: 443}
	principal := domain.ServerPrincipal{RouteID: "route", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000001"}}
	if _, err := domain.PublicPrincipalConnection(route, listener, principal); err == nil {
		t.Fatal("unsupported listener request header projected into principal connection")
	}
}
