package domain

import "testing"

func TestTransportHeadersAreTypedAndRejectAmbiguity(t *testing.T) {
	base := Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &TransportOptions{Type: "ws", Path: "/proxy", Host: "cdn.example", Headers: map[string]string{"X-Client": "fixture"}}}
	if err := ValidateConnection(base); err != nil {
		t.Fatal(err)
	}
	for _, headers := range []map[string]string{{"Host": "ambiguous"}, {"X-Test": "one\r\nInjected: yes"}, {"X-Test": "a", "x-test": "b"}, {"Bad Header": "x"}} {
		c := base
		tr := *base.Transport
		tr.Headers = headers
		c.Transport = &tr
		if ValidateConnection(c) == nil {
			t.Fatal("unsafe headers accepted")
		}
	}
	c := base
	tr := *base.Transport
	tr.Type = "grpc"
	tr.Path = ""
	tr.Host = ""
	tr.Authority = "grpc.example"
	c.Transport = &tr
	if ValidateConnection(c) == nil {
		t.Fatal("HTTP headers accepted on grpc")
	}
	tr.Headers = nil
	if err := ValidateConnection(c); err != nil {
		t.Fatal(err)
	}
}

func TestNewProtocolsRejectCrossProtocolAndLegacyOptions(t *testing.T) {
	base := Connection{Host: "proxy.example", Port: 443, Protocol: "vmess", UUID: "00000000-0000-4000-8000-000000000001", VMessSecurity: "auto"}
	if err := ValidateConnection(base); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Connection){func(c *Connection) { c.VMessSecurity = "unknown" }, func(c *Connection) { c.Flow = "xtls-rprx-vision" }, func(c *Connection) { c.Password = "wrong-auth" }, func(c *Connection) { c.Protocol = "vless" }} {
		c := base
		mutate(&c)
		if ValidateConnection(c) == nil {
			t.Fatal("cross-protocol field accepted")
		}
	}
	base.Protocol = "trojan"
	base.UUID = ""
	base.VMessSecurity = ""
	base.Password = "fixture"
	if ValidateConnection(base) == nil {
		t.Fatal("Trojan without TLS accepted")
	}
	base.TLS = &TLSOptions{Enabled: true}
	if err := ValidateConnection(base); err != nil {
		t.Fatal(err)
	}
}

func TestTransportHandshakeOwnedHeadersCannotBeOverridden(t *testing.T) {
	c := Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &TransportOptions{Type: "ws"}}
	for _, key := range []string{"Connection", "connection", "UPGRADE", "Sec-WebSocket-Key", "sec-websocket-version", "Sec-WebSocket-Extensions", "Content-Length", "transfer-encoding", "Trailer"} {
		c.Transport.Headers = map[string]string{key: "synthetic-value"}
		if ValidateConnection(c) == nil {
			t.Errorf("core-owned header accepted: %s", key)
		}
	}
	c.Transport.Headers = map[string]string{"Authorization": "Bearer synthetic-token", "Cookie": "fixture=1", "X-Client": "fixture", "Sec-WebSocket-Protocol": "rw-proxy"}
	if err := ValidateConnection(c); err != nil {
		t.Fatalf("legitimate request headers rejected: %v", err)
	}
}

func TestGRPCAuthorityRejectsMalformedHTTPAuthority(t *testing.T) {
	c := Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &TransportOptions{Type: "grpc", ServiceName: "service"}}
	for _, authority := range []string{"bad\x00host", "bad\r\nhost", "user@host", "host/path", "host?query", "host#fragment", "bad host"} {
		c.Transport.Authority = authority
		if ValidateConnection(c) == nil {
			t.Fatal("invalid authority accepted")
		}
	}
	for _, authority := range []string{"grpc.example", "grpc.example:443", "[::1]:443"} {
		c.Transport.Authority = authority
		if err := ValidateConnection(c); err != nil {
			t.Fatalf("authority rejected: %v", err)
		}
	}
}
