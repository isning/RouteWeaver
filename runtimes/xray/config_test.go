package managedxray_test

import (
	"encoding/json"
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
	} {
		if managed.Validate([]byte(bad), descriptor()) == nil {
			t.Fatal("untested or bypass config accepted")
		}
	}
}

func TestManagedRejectsUntestedOutboundBypassAndTransportMasks(t *testing.T) {
	for name, outbound := range map[string]map[string]any{
		"outbound Vision": {"protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": "127.0.0.1", "port": 12345, "users": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "encryption": "none", "flow": "xtls-rprx-vision"}}}}}},
		"transport mask":  {"protocol": "freedom", "streamSettings": map[string]any{"finalmask": map[string]any{}}},
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
