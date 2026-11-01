package managedxray_test

import (
	"encoding/json"
	"fmt"
	"github.com/xtls/xray-core/infra/conf"
	"strings"
	"testing"

	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

func descriptor() entrypolicy.Descriptor {
	return entrypolicy.Descriptor{SchemaVersion: 1, AdapterID: "routeweaver/managed-xray", RuntimeVersion: "26.3.27-rw1", CoreVersion: "26.3.27", Bindings: []entrypolicy.Binding{{SubjectID: "opaque-subject", AccountID: "account-1", RouteID: "route-1", EntryID: "entry-1", InboundTag: "public", CredentialVersion: "credential-1", PolicyRevision: "policy-1", CycleID: "cycle-1"}}}
}
func config(port int) []byte {
	b, _ := json.Marshal(map[string]any{"log": map[string]any{"loglevel": "none"}, "inbounds": []any{map[string]any{"tag": "public", "listen": "127.0.0.1", "port": port, "protocol": "vless", "settings": map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "email": "opaque-subject"}}}, "streamSettings": map[string]any{"network": "tcp", "security": "none"}}}, "outbounds": []any{map[string]any{"tag": "direct", "protocol": "freedom"}}})
	return b
}
func TestValidateManagedNativeGrammarAndExactMapping(t *testing.T) {
	if err := managed.Validate(config(22001), descriptor()); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*entrypolicy.Descriptor){
		"wrong upstream version":      func(d *entrypolicy.Descriptor) { d.CoreVersion = "26.3.28" },
		"wrong managed version":       func(d *entrypolicy.Descriptor) { d.RuntimeVersion = "26.3.27" },
		"unmapped authenticated user": func(d *entrypolicy.Descriptor) { d.Bindings[0].SubjectID = "attacker" },
		"missing mapping":             func(d *entrypolicy.Descriptor) { d.Bindings = nil },
		"duplicate mapping":           func(d *entrypolicy.Descriptor) { d.Bindings = append(d.Bindings, d.Bindings[0]) },
	} {
		t.Run(name, func(t *testing.T) {
			d := descriptor()
			change(&d)
			if managed.Validate(config(22001), d) == nil {
				t.Fatal("invalid descriptor accepted")
			}
		})
	}
}
func TestRejectVisionAndUntestedEntryTransport(t *testing.T) {
	for _, bad := range []string{
		strings.Replace(string(config(22001)), `"email":"opaque-subject"`, `"email":"opaque-subject","flow":"xtls-rprx-vision"`, 1),
		strings.Replace(string(config(22001)), `"network":"tcp"`, `"network":"ws"`, 1),
		strings.Replace(string(config(22001)), `"security":"none"`, `"security":"reality"`, 1),
		strings.Replace(string(config(22001)), `"decryption":"none"`, `"decryption":"none","fallbacks":[{"dest":80}]`, 1),
		strings.Replace(string(config(22001)), `"streamSettings":{`, `"streamSettings":{"sockopt":{"acceptProxyProtocol":true},`, 1),
		strings.Replace(string(config(22001)), `"streamSettings":{`, `"streamSettings":{"sockopt":{"tcpMptcp":true},`, 1),
		strings.Replace(string(config(22001)), `"streamSettings":{`, `"streamSettings":{"tlsSettings":{"echSockopt":{"tcpMptcp":true}},`, 1),
	} {
		if managed.Validate([]byte(bad), descriptor()) == nil {
			t.Fatal("untested or bypass config accepted")
		}
	}
}

func TestManagedRejectsUntestedOutboundBypassAndTransportMasks(t *testing.T) {
	for name, outbound := range map[string]map[string]any{
		"outbound Vision":  {"protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": "127.0.0.1", "port": 12345, "users": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "encryption": "none", "flow": "xtls-rprx-vision"}}}}}},
		"ECH socket MPTCP": {"protocol": "freedom", "streamSettings": map[string]any{"security": "tls", "tlsSettings": map[string]any{"echSockopt": map[string]any{"tcpMptcp": true}}}},
		"explicit MPTCP":   {"protocol": "freedom", "streamSettings": map[string]any{"sockopt": map[string]any{"tcpMptcp": true}}},
		"transport mask":   {"protocol": "freedom", "streamSettings": map[string]any{"finalmask": map[string]any{}}},
	} {
		t.Run(name, func(t *testing.T) {
			var native map[string]any
			json.Unmarshal(config(22001), &native)
			native["outbounds"] = []any{outbound}
			encoded, _ := json.Marshal(native)
			if err := managed.Validate(encoded, descriptor()); err == nil {
				t.Fatal("untested managed egress bypass accepted")
			}
		})
	}
	masked := strings.Replace(string(config(22001)), `"streamSettings":{`, `"streamSettings":{"finalmask":{},`, 1)
	if err := managed.Validate([]byte(masked), descriptor()); err == nil {
		t.Fatal("untested entry transport mask accepted")
	}
}

func TestRuntimeReconstructionCreatesFreshExplicitCounterEpoch(t *testing.T) {
	first, err := managed.New(config(22001), descriptor(), newLeaseService(0))
	if err != nil {
		t.Fatal(err)
	}
	before := first.Snapshot()
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := managed.New(config(22001), descriptor(), newLeaseService(0))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	after := second.Snapshot()
	if before.CounterEpoch == "" || after.CounterEpoch == "" || before.CounterEpoch == after.CounterEpoch {
		t.Fatal("restart reused runtime epoch")
	}
	if len(before.Counters) != 1 || len(after.Counters) != 1 {
		t.Fatal("missing initial counter evidence")
	}
	if before.Counters[0].CounterEpoch == after.Counters[0].CounterEpoch || after.Counters[0].CounterEpoch == "" {
		t.Fatal("restart reused binding counter epoch")
	}
	if before.Counters[0].CumulativeBytes != 0 || after.Counters[0].CumulativeBytes != 0 {
		t.Fatal("new runtime did not expose genuine zero baseline")
	}
}

// Certificate pinning is not a managed capability. The pinned native base has
// GO-2026-6651; do not let hand-authored TLS settings opt into that verifier.
func TestManagedRejectsCertificatePinningBeforeNativeConstruction(t *testing.T) {
	for _, direction := range []string{"inbounds", "outbounds"} {
		for _, field := range []string{"pinnedPeerCertSha256", "PinnedPeerCertSha256"} {
			for _, value := range []any{strings.Repeat("ab", 32), "", nil} {
				t.Run(fmt.Sprintf("%s/%s/%v", direction, field, value), func(t *testing.T) {
					var native map[string]any
					if err := json.Unmarshal(config(22001), &native); err != nil {
						t.Fatal(err)
					}
					endpoint := native[direction].([]any)[0].(map[string]any)
					endpoint["streamSettings"] = map[string]any{"network": "tcp", "security": "tls", "tlsSettings": map[string]any{field: value}}
					encoded, err := json.Marshal(native)
					if err != nil {
						t.Fatal(err)
					}
					if err := managed.Validate(encoded, descriptor()); err == nil || !strings.Contains(err.Error(), "certificate pinning") {
						t.Fatalf("expected explicit unsupported certificate pinning error, got %v", err)
					}
					runtime, err := managed.New(encoded, descriptor(), newLeaseService(0))
					if runtime != nil {
						runtime.Close()
						t.Fatal("pinning constructed a runtime")
					}
					if err == nil || !strings.Contains(err.Error(), "certificate pinning") {
						t.Fatalf("New did not reject unsupported pinning: %v", err)
					}
				})
			}
		}
	}
}

func TestManagedRejectsAdvisoryTransportAndDynamicAPIPaths(t *testing.T) {
	for _, network := range []string{"grpc", "hysteria"} {
		for _, direction := range []string{"inbounds", "outbounds"} {
			t.Run(direction+"/"+network, func(t *testing.T) {
				var native map[string]any
				json.Unmarshal(config(22001), &native)
				endpoint := native[direction].([]any)[0].(map[string]any)
				endpoint["streamSettings"] = map[string]any{"network": network, "security": "tls"}
				encoded, _ := json.Marshal(native)
				if err := managed.Validate(encoded, descriptor()); err == nil {
					t.Fatal("unsupported transport accepted")
				}
			})
		}
	}
	for _, field := range []string{"api", "reverse"} {
		t.Run(field, func(t *testing.T) {
			var native map[string]any
			json.Unmarshal(config(22001), &native)
			native[field] = map[string]any{}
			encoded, _ := json.Marshal(native)
			if err := managed.Validate(encoded, descriptor()); err == nil {
				t.Fatal("dynamic API accepted")
			}
		})
	}
}

func TestIndependentPinDecoderMatrix(t *testing.T) {
	pin := `"pinnedPeerCertSha256":"` + strings.Repeat("ab", 32) + `"`
	for _, direction := range []string{"inbounds", "outbounds"} {
		for name, stream := range map[string]string{
			"ordinary":              `"streamSettings":{"network":"tcp","security":"tls","tlsSettings":{"serverName":"example.invalid"}}`,
			"pin":                   `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `}}`,
			"pin then empty object": `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `},"tlsSettings":{}}`,
			"empty object then pin": `"streamSettings":{"security":"tls","tlsSettings":{},"tlsSettings":{` + pin + `}}`,
			"pin then null":         `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `,"pinnedPeerCertSha256":null}}`,
			"pin then empty":        `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `,"pinnedPeerCertSha256":""}}`,
			"stream merge":          `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `}},"streamSettings":{}`,
			"null stream":           `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `}},"streamSettings":null`,
			"null TLS":              `"streamSettings":{"security":"tls","tlsSettings":{` + pin + `},"tlsSettings":null}`,
			"fold":                  `"STREAMSETTINGS":{"security":"tls","TLSSETTINGS":{"PINNEDPEERCERTSHA256":"` + strings.Repeat("ab", 32) + `"}}`,
			"escaped":               `"streamSettings":{"security":"tls","tlsSettings":{"\u0070innedPeerCertSha256":"` + strings.Repeat("ab", 32) + `"}}`,
			"unicode fold":          `"streamSettings":{"security":"tls","tlsSettings":{"pinnedPeerCertſha256":"` + strings.Repeat("ab", 32) + `"}}`,
		} {
			t.Run(direction+"/"+name, func(t *testing.T) {
				native := string(config(22001))
				if direction == "inbounds" {
					native = strings.Replace(native, `"streamSettings":{"network":"tcp","security":"none"}`, stream, 1)
				} else {
					native = strings.Replace(native, `"protocol":"freedom"`, `"protocol":"freedom",`+stream, 1)
				}
				var parsed conf.Config
				if err := json.Unmarshal([]byte(native), &parsed); err != nil {
					t.Fatal(err)
				}
				st := parsed.InboundConfigs[0].StreamSetting
				if direction == "outbounds" {
					st = parsed.OutboundConfigs[0].StreamSetting
				}
				livePin := st != nil && st.TLSSettings != nil && st.TLSSettings.PinnedPeerCertSha256 != ""
				err := managed.Validate([]byte(native), descriptor())
				if name == "ordinary" {
					if err != nil {
						t.Fatal(err)
					}
					return
				}
				if err == nil || !strings.Contains(err.Error(), "certificate pinning") {
					t.Fatalf("livePin=%v, expected pin rejection, got %v", livePin, err)
				}
				r, err := managed.New([]byte(native), descriptor(), newLeaseService(0))
				if r != nil {
					r.Close()
					t.Fatal("constructed runtime")
				}
				if err == nil {
					t.Fatal("New accepted")
				}
				t.Logf("native live pin=%v; both public seams rejected", livePin)
			})
		}
	}
	for _, suffix := range []string{` {}`, ` null`, ` garbage`} {
		if managed.Validate(append(config(22001), suffix...), descriptor()) == nil {
			t.Fatal("trailing JSON accepted")
		}
	}
}
