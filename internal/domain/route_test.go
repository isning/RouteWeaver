package domain_test

import (
	"routeweaver/internal/domain"
	"testing"
)

func TestRouteRejectsRepeatedNode(t *testing.T) {
	n := []domain.Node{{ID: "a", Name: "A", Host: "example.org", Port: 1080, Protocol: "socks"}}
	r := domain.Route{ID: "r", Name: "route", Engine: "xray", Hops: []string{"a", "a"}}
	if err := domain.ValidateRoute(r, n); err == nil {
		t.Fatal("cycle accepted")
	}
}

func TestLegacyAndSeparatedConnectionValidationRejectUnusedProtocolFields(t *testing.T) {
	for _, c := range []domain.Connection{
		{Protocol: "socks", Host: "example.org", Port: 1080, Method: "aes-128-gcm"},
		{Protocol: "shadowsocks", Host: "example.org", Port: 8388, Method: "aes-128-gcm", Password: "fixture", Username: "ignored"},
		{Protocol: "socks", Host: "example.org", Port: 1080, TLS: &domain.TLSOptions{Enabled: true}},
		{Protocol: "shadowsocks", Host: "example.org", Port: 8388, Method: "aes-128-gcm", Password: "fixture", Transport: &domain.TransportOptions{Type: "ws"}},
	} {
		if err := domain.ValidateConnection(c); err == nil {
			t.Fatalf("separated connection silently drops fields: %#v", c)
		}
		n := domain.Node{ID: "node", Name: "Node", Host: c.Host, Port: c.Port, Protocol: c.Protocol, Username: c.Username, Password: c.Password, Method: c.Method, TLS: c.TLS, Transport: c.Transport}
		if err := domain.ValidateNode(n); err == nil {
			t.Fatalf("legacy node silently drops fields: %#v", c)
		}
	}
}
