//go:build linux

package integration_test

import (
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"

	"routeweaver/internal/domain"
)

// Trust only this generated fixture CA in the owned test client's TLS settings.
// Xray now uses bundled roots by default, so SSL_CERT_FILE alone is not a fixture
// trust contract. This does not alter system trust or disable chain/name checks.
// Official schema: XTLS/Xray-core v26.10.29 infra/conf/transport_security.go.
func stockFixtureCATrust(t *testing.T, artifacts []domain.Artifact, caPath string) []domain.Artifact {
	t.Helper()
	ca, err := os.ReadFile(caPath)
	if err != nil {
		t.Fatal(err)
	}
	result := append([]domain.Artifact(nil), artifacts...)
	for i, a := range artifacts {
		if !strings.HasSuffix(a.Path, "/config.json") {
			continue
		}
		var config map[string]any
		if err = json.Unmarshal([]byte(a.Content), &config); err != nil {
			t.Fatal(err)
		}
		changed := false
		for _, value := range config["outbounds"].([]any) {
			outbound := value.(map[string]any)
			stream, ok := outbound["streamSettings"].(map[string]any)
			if !ok {
				continue
			}
			tls, ok := stream["tlsSettings"].(map[string]any)
			if !ok {
				continue
			}
			tls["certificates"] = []any{map[string]any{"certificateFile": "tls/fixture-ca.pem", "usage": "verify"}}
			tls["disableSystemRoot"] = true
			if tls["allowInsecure"] == true {
				t.Fatal("test must not disable TLS verification")
			}
			changed = true
		}
		if changed {
			raw, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			result[i].Content = string(raw)
			instance, _, _ := strings.Cut(a.Path, "/")
			result = append(result, domain.Artifact{Path: instance + "/tls/fixture-ca.pem", Content: string(ca)})
		}
	}
	return result
}

func TestNativeStockXraySecurityDefaults(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit exact-cache Xray process opt-in required")
	}
	// The hostname is passed through SOCKS to the core, not pre-resolved by
	// the client. Require local-only hosts resolution before running the fixture.
	addresses, err := net.LookupIP("localhost")
	if err != nil || len(addresses) == 0 {
		t.Fatal("localhost fixture resolution unavailable", err)
	}
	for _, address := range addresses {
		if !address.IsLoopback() {
			t.Fatal("localhost did not resolve only to loopback")
		}
	}
	for _, tc := range []struct {
		name, protocol string
		options        stockLoopbackOptions
	}{
		{"private-target-default-denied", "vmess", stockLoopbackOptions{wantDenied: true}},
		{"hostname-resolved-private-default-denied", "vmess", stockLoopbackOptions{destinationHost: "localhost", wantDenied: true}},
		{"hostname-resolved-exact-loopbacks-allowed", "vmess", stockLoopbackOptions{destinationHost: "localhost", privateCIDRs: []string{"127.0.0.1/32", "::1/128"}}},
		{"nonmatching-private-exception-denied", "vmess", stockLoopbackOptions{privateCIDRs: []string{"127.0.0.2/32"}, wantDenied: true}},
		{"custom-ca-not-implicitly-trusted", "trojan", stockLoopbackOptions{privateCIDRs: []string{"127.0.0.1/32"}, wantDenied: true}},
		{"trusted-ca-wrong-hostname-denied", "trojan", stockLoopbackOptions{privateCIDRs: []string{"127.0.0.1/32"}, trustFixtureCA: true, wrongServerName: true, wantDenied: true}},
	} {
		t.Run(tc.name, func(t *testing.T) { endpointProtocolLoopback(t, dir, tc.protocol, "tcp", tc.options) })
	}
}
