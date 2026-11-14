package diagnostics_test

import (
	"routeweaver/internal/diagnostics"
	"strings"
	"testing"
)

func TestCoreDiagnosticClassificationNeverReturnsCapturedText(t *testing.T) {
	cases := []struct{ adapter, version, line, want string }{
		{"routeweaver/xray", "26.3.27", "Failed to start: app/proxyman/inbound: failed to listen TCP on 55123 > transport/internet: failed to listen on address: 127.0.0.1:55123 > transport/internet/tcp: failed to listen TCP on 127.0.0.1:55123 > listen tcp 127.0.0.1:55123: bind: address already in use", "listener_address_in_use"},
		{"routeweaver/xray", "26.3.27", "Failed to start: main: failed to load config files: [/private/config.json] > infra/conf: failed to build inbound config with tag secret > infra/conf: Failed to build TLS config. > infra/conf: failed to parse certificate > open /private/secret.pem: no such file or directory", "tls_certificate_file_missing"},
		{"routeweaver/sing-box", "1.14.3", "\x1b[31mFATAL\x1b[0m[0000] decode config at /private/config.json: inbounds[0]: unknown inbound type: secret", "unsupported_protocol_configuration"},
		{"routeweaver/sing-box", "1.14.3", "FATAL[0000] start service: initialize network: create netlink socket: operation not permitted", "network_initialization_permission_denied"},
	}
	for _, c := range cases {
		if got := diagnostics.ClassifyCoreLine(c.adapter, c.version, c.line); got != c.want {
			t.Fatalf("classification %q want %q", got, c.want)
		}
	}
	for _, c := range cases {
		version := "1.14.4"
		line := c.line
		if c.adapter == "routeweaver/xray" {
			version = "26.10.31"
			line = strings.Replace(line, "transport/internet/tcp: failed to listen TCP", "transport/internet/tcp: failed to listen tcp", 1)
		}
		if got := diagnostics.ClassifyCoreLine(c.adapter, version, line); got != c.want {
			t.Fatalf("current version classification %s %q", version, got)
		}
	}
	for _, line := range []string{"from tcp:127.0.0.1:1 accepted tcp:example.invalid:443", "https://user:secret@example.invalid/token", strings.Repeat("x", 4097), cases[0].line + "\nsecret"} {
		if diagnostics.ClassifyCoreLine("routeweaver/xray", "26.3.27", line) != "" {
			t.Fatal("unrecognized/private text emitted")
		}
	}
	if diagnostics.ClassifyCoreLine("routeweaver/xray", "26.10.29", cases[0].line) != "" {
		t.Fatal("unqualified version accepted")
	}
}
