package domain

import "testing"

func TestHysteria2OptionsRejectInvalidAndCrossProtocolValues(t *testing.T) {
	base := Connection{Protocol: "hysteria2", Host: "proxy.example", Port: 443, Password: "synthetic", TLS: &TLSOptions{Enabled: true}}
	for _, options := range []*Hysteria2Options{
		{Obfs: &ObfuscationOptions{Type: "salamander"}},
		{Obfs: &ObfuscationOptions{Type: "unknown", Password: "synthetic"}},
		{ServerPorts: []string{"2000:1000"}}, {ServerPorts: []string{"0"}}, {ServerPorts: []string{"65536"}},
		{HopIntervalSeconds: 30}, {ServerPorts: []string{"443"}, HopIntervalSeconds: -1}, {UpMbps: -1},
	} {
		c := base
		c.Hysteria2 = options
		if ValidateConnection(c) == nil {
			t.Fatal("invalid HY2 options accepted")
		}
	}
	c := Connection{Protocol: "socks", Host: "proxy.example", Port: 1080, Hysteria2: &Hysteria2Options{UpMbps: 10}}
	if ValidateConnection(c) == nil {
		t.Fatal("HY2 settings accepted by SOCKS")
	}
}

func TestTUICRequiresBothCredentialsAndOrdinaryTLS(t *testing.T) {
	base := Connection{Protocol: "tuic", Host: "proxy.example", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", Password: "synthetic", TLS: &TLSOptions{Enabled: true}, TUIC: &TUICOptions{CongestionControl: "bbr", UDPRelayMode: "native"}}
	if err := ValidateConnection(base); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Connection){func(c *Connection) { c.UUID = "" }, func(c *Connection) { c.Password = "" }, func(c *Connection) { c.TLS = nil }, func(c *Connection) { c.Transport = &TransportOptions{Type: "ws"} }, func(c *Connection) { c.TUIC = &TUICOptions{CongestionControl: "unknown"} }, func(c *Connection) { c.TUIC = &TUICOptions{UDPRelayMode: "unknown"} }, func(c *Connection) { c.Protocol = "vless" }} {
		c := base
		change(&c)
		if ValidateConnection(c) == nil {
			t.Fatal("invalid TUIC envelope accepted")
		}
	}
}
