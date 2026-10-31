package render_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func withNative(t *testing.T, p domain.ClientProfileIR, target render.Target, format, content, ruleMode string) domain.ClientProfileIR {
	t.Helper()
	raw, _ := json.Marshal(p)
	var object map[string]any
	_ = json.Unmarshal(raw, &object)
	object["nativeOverride"] = map[string]any{"schemaVersion": "1", "namespace": "routeweaver/native-client", "target": target, "format": format, "content": content, "ruleMode": ruleMode}
	raw, _ = json.Marshal(object)
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNativeOverrideAddsProcessPolicyAndFakeIPWithoutChangingGeneratedConnections(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := clientProfile()
	base, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	content := `dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver: [https://1.1.1.1/dns-query]
proxy-groups:
  - name: Native applications
    type: select
    proxies: [Choose, DIRECT]
rules:
  - PROCESS-NAME,curl,Native applications
`
	p = withNative(t, p, target, "yaml", content, "prepend")
	got, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = json.Unmarshal([]byte(base.Artifacts[0].Content), &before)
	_ = json.Unmarshal([]byte(got.Artifacts[0].Content), &after)
	if after["dns"] == nil || after["dns"].(map[string]any)["enhanced-mode"] != "fake-ip" {
		t.Fatal("native fake-IP DNS was silently discarded")
	}
	if after["rules"].([]any)[0] != "PROCESS-NAME,curl,Native applications" {
		t.Fatal("native process policy must precede generated rules")
	}
	if !reflect.DeepEqual(after["proxies"], before["proxies"]) {
		t.Fatal("native data changed generated connection identities or credentials")
	}
	if !strings.Contains(got.Artifacts[0].Content, "Native applications") {
		t.Fatal("native group missing")
	}
	second, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil || second.Artifacts[0].Content != got.Artifacts[0].Content {
		t.Fatal("regeneration lost native edits")
	}
}

func TestNativeSingBoxOverrideAddsApplicationGroupAndPreservesFallback(t *testing.T) {
	target := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	p := clientProfile()
	p.Runtime.Sniff = true
	p.DefaultAction = domain.ActionRef{Kind: "reject"}
	p = withNative(t, p, target, "json", `{"dns":{"strategy":"prefer_ipv4","cache_capacity":1024},"outbounds":[{"type":"selector","tag":"Native applications","outbounds":["Choose","rw-direct"],"interrupt_exist_connections":true}],"route":{"rules":[{"process_name":["curl"],"action":"route","outbound":"Native applications"}]}}`, "prepend")
	got, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	_ = json.Unmarshal([]byte(got.Artifacts[0].Content), &data)
	rules := data["route"].(map[string]any)["rules"].([]any)
	if rules[0].(map[string]any)["action"] != "sniff" || rules[1].(map[string]any)["outbound"] != "Native applications" || rules[len(rules)-1].(map[string]any)["action"] != "reject" {
		t.Fatalf("native policy dropped preprocessing or default rejection: %v", rules)
	}
	if got.NativeOverride == nil || got.NativeOverride.Validation != "upstream-json-schema-and-references" {
		t.Fatal("validation provenance missing")
	}
}

func TestNativeOverrideRejectsForeignDNSDetour(t *testing.T) {
	target := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	p := withNative(t, clientProfile(), target, "json", `{"dns":{"servers":[{"type":"https","tag":"secure","server":"1.1.1.1","detour":"foreign-user-exit"}],"final":"secure"}}`, "prepend")
	if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err == nil || !strings.Contains(err.Error(), "NATIVE_REFERENCE") {
		t.Fatalf("foreign DNS detour accepted: %v", err)
	}
}

func TestNativeOverrideRejectsUnsupportedConflictsAndForeignReferences(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	tests := []struct{ name, content, code string }{
		{"generated credentials", `{"proxies":[{"name":"Injected","password":"sensitive-value"}]}`, "NATIVE_PROTECTED_FIELD"},
		{"unknown mandatory field", `{"mandatory-future-feature":true}`, "NATIVE_PROTECTED_FIELD"},
		{"invalid known field", `{"tcp-concurrent":"not-boolean"}`, "NATIVE_SCHEMA"},
		{"null deletion", `{"dns":null}`, "NATIVE_DELETE_CONFLICT"},
		{"foreign rule target", `{"rules":["PROCESS-NAME,curl,foreign-user-exit"]}`, "NATIVE_REFERENCE"},
		{"foreign resource", `{"rules":["RULE-SET,foreign-private-rules,DIRECT"]}`, "NATIVE_REFERENCE"},
		{"raw resource URL", `{"rule-providers":{"remote":{"url":"https://private.example/feed?token=synthetic"}}}`, "NATIVE_PROTECTED_FIELD"},
		{"native group replaces managed", `{"proxy-groups":[{"name":"Choose","type":"select","proxies":["DIRECT"]}]}`, "NATIVE_IDENTITY_CONFLICT"},
		{"native group cycle", `{"proxy-groups":[{"name":"A","type":"select","proxies":["B"]},{"name":"B","type":"select","proxies":["A"]}]}`, "NATIVE_GROUP_CYCLE"},
		{"duplicate key", `{"dns":{"enable":true,"enable":false}}`, "NATIVE_SYNTAX"},
		{"native schema injection", `{"$schema":"file:///etc/passwd"}`, "NATIVE_PROTECTED_FIELD"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := withNative(t, clientProfile(), target, "json", tt.content, "prepend")
			_, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err == nil || !strings.Contains(err.Error(), tt.code) {
				t.Fatalf("%s: got %v", tt.code, err)
			}
		})
	}
	for _, mode := range []string{"append", "replace"} {
		p := withNative(t, clientProfile(), target, "json", `{"rules":["PROCESS-NAME,curl,REJECT"]}`, mode)
		got, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		var data map[string]any
		_ = json.Unmarshal([]byte(got.Artifacts[0].Content), &data)
		rules := data["rules"].([]any)
		if rules[len(rules)-1] != "MATCH,DIRECT" {
			t.Fatal("native rule merge removed the explicit fallback")
		}
		if mode == "replace" && (len(rules) != 2 || rules[0] != "PROCESS-NAME,curl,REJECT") {
			t.Fatal("replace retained unwanted generated policy")
		}
		if mode == "append" && (len(rules) != 3 || rules[1] != "PROCESS-NAME,curl,REJECT") {
			t.Fatal("append priority incorrect")
		}
	}
	p := withNative(t, clientProfile(), target, "json", `{}`, "prepend")
	if _, err := render.DefaultClients().Render(p, target, render.NodesOnly); err == nil || !strings.Contains(err.Error(), "NATIVE_MODE_CONFLICT") {
		t.Fatalf("nodes-only silently dropped native intent: %v", err)
	}
	p.NativeOverride.Target.Version = "older-version"
	if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err == nil || !strings.Contains(err.Error(), "NATIVE_TARGET_MISMATCH") {
		t.Fatalf("version scope ignored: %v", err)
	}
}

func TestNativeDiagnosticNeverEchoesUntrustedPropertyNames(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := withNative(t, clientProfile(), target, "json", `{"synthetic-native-private-secret":"value"}`, "prepend")
	_, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err == nil || strings.Contains(err.Error(), "synthetic-native-private-secret") {
		t.Fatalf("diagnostic reflected untrusted data: %v", err)
	}
}

func TestNativeReferencesAreClientDataNotControlPlaneReads(t *testing.T) {
	target := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	p := withNative(t, clientProfile(), target, "json", `{"dns":{"servers":[{"type":"hosts","tag":"device-hosts","path":"/nonexistent-client-only/hosts"}],"rules":[{"domain_suffix":["internal.example"],"action":"route","server":"device-hosts"}]},"log":{"output":"/nonexistent-client-only/client.log"}}`, "prepend")
	got, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatalf("render tried to load a client file or rejected valid client-only path: %v", err)
	}
	if !strings.Contains(got.Artifacts[0].Content, "/nonexistent-client-only/hosts") {
		t.Fatal("client-local file path was discarded")
	}
}

func TestNativeChangeReportDistinguishesAdditionsFromReplacements(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := withNative(t, clientProfile(), target, "json", `{"log-level":"info","proxy-groups":[{"name":"Native","type":"select","proxies":["DIRECT"]}],"rules":["PROCESS-NAME,curl,DIRECT"]}`, "prepend")
	result, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.NativeOverride.ReplacedPaths, []string{"/log-level"}) {
		t.Fatalf("additive native policy reported as replacing structured policy: %#v", result.NativeOverride)
	}
}

func TestNativeSingBoxRejectsCredentialMaterialOutsideConnections(t *testing.T) {
	target := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	p := withNative(t, clientProfile(), target, "json", `{"dns":{"servers":[{"type":"tls","tag":"client-auth","server":"1.1.1.1","tls":{"enabled":true,"client_key":"synthetic-private-key"}}]}}`, "prepend")
	_, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err == nil || !strings.Contains(err.Error(), "NATIVE_CREDENTIAL_FIELD") {
		t.Fatalf("native credential channel accepted: %v", err)
	}
}

func TestNativeDNSResolverCyclesAndDanglingMihomoSelectorsAreRejected(t *testing.T) {
	sing := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	for _, content := range []string{
		`{"dns":{"servers":[{"type":"https","tag":"A","server":"dns.example","domain_resolver":"A"}]}}`,
		`{"dns":{"servers":[{"type":"https","tag":"A","server":"a.example","domain_resolver":"B"},{"type":"https","tag":"B","server":"b.example","domain_resolver":"A"}]}}`,
	} {
		p := withNative(t, clientProfile(), sing, "json", content, "prepend")
		if _, err := render.DefaultClients().Render(p, sing, render.FullConfig); err == nil || !strings.Contains(err.Error(), "NATIVE_DNS_CYCLE") {
			t.Fatalf("cyclic DNS dependencies accepted: %v", err)
		}
	}
	mihomo := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	for _, content := range []string{
		`{"dns":{"enable":true,"nameserver":["https://1.1.1.1/dns-query#foreign-group"]}}`,
		`{"dns":{"enable":true,"nameserver":["https://1.1.1.1/dns-query#Choose"]}}`,
		`{"dns":{"enable":true,"nameserver":["https://1.1.1.1/dns-query"],"nameserver-policy":{"rule-set:foreign-resource":["1.1.1.1"]}}}`,
	} {
		p := withNative(t, clientProfile(), mihomo, "json", content, "prepend")
		if _, err := render.DefaultClients().Render(p, mihomo, render.FullConfig); err == nil {
			t.Fatal("dangling or bootstrap-ambiguous native DNS selector accepted")
		}
	}
}

func TestNativeCapabilitiesAreDeclaredBySupportedAdaptersOnly(t *testing.T) {
	raw, _ := json.Marshal(render.DefaultClients().Capabilities())
	if !strings.Contains(string(raw), `"nativeOverride"`) {
		t.Fatal("native editing has no versioned capability declaration")
	}
	p := withNative(t, clientProfile(), render.Target{AdapterID: "fixture/third", Version: "test-1"}, "json", `{}`, "prepend")
	if _, err := render.NewClients(syntheticClient{}).Render(p, render.Target{AdapterID: "fixture/third", Version: "test-1"}, render.FullConfig); err == nil || !strings.Contains(err.Error(), "NATIVE_UNSUPPORTED") {
		t.Fatalf("adapter without native capability accepted native data: %v", err)
	}
}

func TestNativeSingBoxRejectsUnmanagedServiceAndNamespaceReferences(t *testing.T) {
	target := render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	for _, content := range []string{
		`{"dns":{"servers":[{"type":"tailscale","tag":"tail","endpoint":"foreign-service"}]}}`,
		`{"dns":{"servers":[{"type":"udp","tag":"custom","server":"1.1.1.1","netns":"foreign-namespace"}]}}`,
		`{"route":{"rules":[{"inbound":["foreign-inbound"],"action":"route","outbound":"rw-direct"}]}}`,
	} {
		p := withNative(t, clientProfile(), target, "json", content, "prepend")
		if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err == nil || !strings.Contains(err.Error(), "NATIVE_REFERENCE") {
			t.Fatalf("unmanaged native reference accepted: %v", err)
		}
	}
}

func TestNativeNumericObjectKeysAreNotReflectedAsArrayIndices(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := withNative(t, clientProfile(), target, "json", `{"928374651":"synthetic-secret"}`, "prepend")
	_, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err == nil || strings.Contains(err.Error(), "928374651") {
		t.Fatalf("numeric untrusted object key leaked: %v", err)
	}
}
