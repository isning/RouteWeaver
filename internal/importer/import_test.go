package importer

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseVLESSPreservesConnectionAndStableNameIdentity(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("vless://00000000-0000-4000-8000-000000000001@proxy.example:443?type=ws&security=tls&sni=www.example.com&path=%2Fproxy&host=ws.example.com&alpn=h2%2Chttp%2F1.1#UK")}
	result, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Snapshot.Endpoints) != 1 {
		t.Fatal("missing endpoint")
	}
	e := result.Snapshot.Endpoints[0]
	if e.Name != "UK" || e.Connection.Protocol != "vless" || e.Connection.UUID != "00000000-0000-4000-8000-000000000001" || e.Connection.TLS.ServerName != "www.example.com" || e.Connection.Transport.Path != "/proxy" {
		t.Fatalf("lost fields: %s", e.ID)
	}
	req.SnapshotID = "snap2"
	req.Data = []byte(strings.Replace(string(req.Data), "#UK", "#Renamed", 1))
	next, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Snapshot.Endpoints[0].ID != e.ID {
		t.Fatal("rename changed identity")
	}
}

func TestParseMihomoExtractsNodesAndReportsOtherConfig(t *testing.T) {
	result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "mihomo", Data: []byte("proxies:\n  - name: UK\n    type: ss\n    server: proxy.example\n    port: 443\n    cipher: aes-128-gcm\n    password: fixture-only\nrules:\n  - MATCH,DIRECT\n")})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Complete || len(result.Snapshot.Endpoints) != 1 || len(result.Warnings) == 0 {
		t.Fatalf("missing import result or ignored-config warning")
	}
	if result.Snapshot.Endpoints[0].Connection.Password != "fixture-only" {
		t.Fatal("credential lost")
	}
}
func TestParseSingBoxExtractsNodesNotInternalGroups(t *testing.T) {
	result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "sing-box", Data: []byte(`{"outbounds":[{"type":"socks","tag":"UK","server":"proxy.example","server_port":1080,"version":"5"},{"type":"direct","tag":"direct"}],"route":{"final":"UK"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Snapshot.Endpoints) != 1 || len(result.Warnings) == 0 {
		t.Fatal("non-node export not identified")
	}
}

func TestParseNoAuthSOCKSAndBase64SS(t *testing.T) {
	for _, req := range []Request{
		{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("socks5://proxy.example:1080#Local")},
		{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "base64", Data: []byte("c3M6Ly9ZV1Z6TFRFeU9DMW5ZMjA2Wm1sNGRIVnlaUzF2Ym14NUByZW1vdGUuZXhhbXBsZTo0NDMjVUs=")},
	} {
		r, err := Parse(req)
		if err != nil {
			t.Fatal(err)
		}
		if len(r.Snapshot.Endpoints) != 1 {
			t.Fatal("missing imported connection")
		}
	}
}
func TestParseRejectsDuplicateJSONKeysAndNeverLeaksCredentials(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "sing-box", Data: []byte(`{"outbounds":[{"type":"shadowsocks","tag":"UK","server":"proxy.example","server_port":443,"method":"aes-128-gcm","password":"top-secret","password":"other"}]}`)}
	_, err := Parse(req)
	if err == nil {
		t.Fatal("ambiguous duplicate key accepted")
	}
	if strings.Contains(err.Error(), "top-secret") {
		t.Fatal("secret leaked")
	}
}

func TestParseRejectsUnsupportedSecurityWithoutPartialSnapshot(t *testing.T) {
	inputs := []struct{ format, data string }{
		{"uri-list", "vless://00000000-0000-4000-8000-000000000001@proxy.example:443?security=tls&allowInsecure=1#top-secret"},
		{"uri-list", "socks5://one.example:1080#Good\nunknown://private-secret@two.example:443"},
		{"mihomo", "proxies:\n - name: Example\n   type: vless\n   server: proxy.example\n   port: 443\n   uuid: 00000000-0000-4000-8000-000000000001\n   tls: true\n   skip-cert-verify: true\n"},
	}
	for _, input := range inputs {
		result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: input.format, Data: []byte(input.data)})
		if err == nil || result.Complete || len(result.Snapshot.Endpoints) != 0 {
			t.Fatal("bad candidate accepted")
		}
		if strings.Contains(err.Error(), "private-secret") || strings.Contains(err.Error(), "top-secret") {
			t.Fatal("error leaked input")
		}
	}
}
func TestCredentialRotationDoesNotChangeSourceIdentity(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "sing-box", Data: []byte(`{"outbounds":[{"type":"shadowsocks","tag":"UK","server":"proxy.example","server_port":443,"method":"aes-128-gcm","password":"old-fixture"}]}`)}
	old, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Data = []byte(strings.Replace(string(req.Data), "old-fixture", "new-fixture", 1))
	req.SnapshotID = "snap2"
	next, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if old.Snapshot.Endpoints[0].ID != next.Snapshot.Endpoints[0].ID {
		t.Fatal("credential rotation changed identity")
	}
}
func FuzzParseUntrustedSources(f *testing.F) {
	f.Add("uri-list", []byte("socks5://proxy.example:1080#UK"))
	f.Add("mihomo", []byte("proxies: []"))
	f.Add("sing-box", []byte(`{"outbounds":[]}`))
	f.Fuzz(func(t *testing.T, format string, data []byte) {
		if len(data) > 65536 {
			t.Skip()
		}
		_, _ = Parse(Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: format, Data: data})
	})
}

func TestLateValidationFailureReturnsNoCandidateSnapshot(t *testing.T) {
	result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("socks5://one.example:1080#Good\nvless://not-a-uuid@two.example:443#Bad")})
	if err == nil || len(result.Snapshot.Endpoints) != 0 {
		t.Fatal("failed import returned partially usable snapshot")
	}
}

func TestMultipleAccountsOnSameServerPreserveIdentitiesAcrossReorder(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("socks5://first:fixture-one@proxy.example:1080#One\nsocks5://second:fixture-two@proxy.example:1080#Two")}
	first, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Previous = &first.Snapshot
	req.SnapshotID = "snap2"
	req.Data = []byte("socks5://second:fixture-two@proxy.example:1080#Renamed\nsocks5://first:fixture-one@proxy.example:1080#One")
	next, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Snapshot.Endpoints[0].ID != first.Snapshot.Endpoints[1].ID || next.Snapshot.Endpoints[1].ID != first.Snapshot.Endpoints[0].ID {
		t.Fatal("reorder or rename reassigned identity")
	}
}

func TestAmbiguousBulkCredentialChangesKeepPreviousSnapshot(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("socks5://first:fixture-one@proxy.example:1080#One\nsocks5://second:fixture-two@proxy.example:1080#Two")}
	previous, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Previous = &previous.Snapshot
	req.SnapshotID = "snap2"
	req.Data = []byte("socks5://third:fixture-three@proxy.example:1080#Changed\nsocks5://fourth:fixture-four@proxy.example:1080#Changed")
	next, err := Parse(req)
	if err == nil || next.Complete || len(next.Snapshot.Endpoints) != 0 {
		t.Fatal("ambiguous reassociation accepted")
	}
	if previous.Snapshot.Endpoints[0].Connection.Username != "first" {
		t.Fatal("prior snapshot mutated")
	}
}
func TestAddingSameLocationDoesNotRenameOriginalIdentity(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("socks5://first:fixture-one@proxy.example:1080#One")}
	first, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Previous = &first.Snapshot
	req.SnapshotID = "snap2"
	req.Data = []byte("socks5://second:fixture-two@proxy.example:1080#Two\nsocks5://first:fixture-one@proxy.example:1080#Renamed")
	next, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Snapshot.Endpoints[1].ID != first.Snapshot.Endpoints[0].ID || next.Snapshot.Endpoints[0].ID == next.Snapshot.Endpoints[1].ID {
		t.Fatal("existing identity changed or collapsed")
	}
}

func TestAutoDetectionUsesInputStructureNotWordsInsideNames(t *testing.T) {
	for _, input := range []string{"# provider comment\nsocks5://proxy.example:1080#proxies:", "proxies :\n - name: UK\n   type: socks5\n   server: proxy.example\n   port: 1080\n"} {
		result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "auto", Data: []byte(input)})
		if err != nil || len(result.Snapshot.Endpoints) != 1 {
			t.Fatalf("valid auto input failed: %v", err)
		}
	}
}

func TestRealityCredentialRotationDoesNotAffectIdentity(t *testing.T) {
	req := Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "uri-list", Data: []byte("vless://00000000-0000-4000-8000-000000000001@proxy.example:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=0123456789abcdef#UK")}
	previous, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Data = []byte(strings.Replace(string(req.Data), "0123456789abcdef", "fedcba9876543210", 1))
	req.SnapshotID = "snap2"
	next, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Snapshot.Endpoints[0].ID != previous.Snapshot.Endpoints[0].ID {
		t.Fatal("REALITY short ID was part of exported identity")
	}
}

func TestMihomoHTTPUpgradePreservesNativeTransport(t *testing.T) {
	result, err := Parse(Request{SourceID: "airport", OwnerID: "alice", SnapshotID: "snap1", Format: "mihomo", Data: []byte(`{"proxies":[{"name":"Upgrade","type":"vless","server":"proxy.example","port":443,"uuid":"00000000-0000-4000-8000-000000000001","network":"ws","ws-opts":{"path":"/proxy","headers":{"Host":"cdn.example"},"v2ray-http-upgrade":true}}]}`)})
	if err != nil {
		t.Fatal(err)
	}
	c := result.Snapshot.Endpoints[0].Connection
	if c.Transport == nil || c.Transport.Type != "httpupgrade" || c.Transport.Host != "cdn.example" || c.Transport.Path != "/proxy" {
		t.Fatal("HTTPUpgrade semantics lost")
	}
}

func TestTrojanURIRequiresOrdinaryTLSAndPreservesPassword(t *testing.T) {
	base := "trojan://p%40ss@proxy.example:443?type=ws&path=%2Fproxy&sni=tls.example"
	req := Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "uri-list", Data: []byte(base)}
	result, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	c := result.Snapshot.Endpoints[0].Connection
	if c.Protocol != "trojan" || c.Password != "p@ss" || c.TLS == nil || !c.TLS.Enabled || c.Transport.Path != "/proxy" {
		t.Fatal("Trojan URI fields lost")
	}
	for _, extra := range []string{"&security=none", "&security=reality", "&flow=xtls-rprx-vision", "&encryption=none"} {
		req.Data = []byte(base + extra)
		if _, err := Parse(req); err == nil {
			t.Fatal("unsupported Trojan options accepted")
		}
	}
}

func TestVMessAEADShareLinkAndLegacyRejection(t *testing.T) {
	body := `{"v":"2","ps":"VMess","add":"proxy.example","port":"443","id":"00000000-0000-4000-8000-000000000001","aid":"0","scy":"auto","net":"grpc","type":"none","path":"service","tls":"tls","sni":"tls.example"}`
	request := Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "uri-list", Data: []byte("vmess://" + base64.StdEncoding.EncodeToString([]byte(body)))}
	result, err := Parse(request)
	if err != nil {
		t.Fatal(err)
	}
	c := result.Snapshot.Endpoints[0].Connection
	if c.Protocol != "vmess" || c.Transport.ServiceName != "service" || c.VMessSecurity != "auto" {
		t.Fatal("VMess share link lost fields")
	}
	for _, bad := range []string{strings.Replace(body, `"aid":"0"`, `"aid":"64"`, 1), strings.Replace(body, `"tls":"tls"`, `"tls":"reality"`, 1), strings.Replace(body, `"scy":"auto"`, `"insecure":"1","scy":"auto"`, 1)} {
		request.Data = []byte("vmess://" + base64.StdEncoding.EncodeToString([]byte(bad)))
		if _, err := Parse(request); err == nil {
			t.Fatal("unsupported link accepted")
		}
	}
}

func TestNativeProtocolSpecificFieldsCannotBeSilentlyIgnored(t *testing.T) {
	for _, body := range []string{
		`{"outbounds":[{"type":"trojan","tag":"T","server":"proxy.example","server_port":443,"password":"fixture","tls":{"enabled":true},"alter_id":0}]}`,
		`{"outbounds":[{"type":"trojan","tag":"T","server":"proxy.example","server_port":443,"password":"fixture","tls":{"enabled":true},"version":"5"}]}`,
		`{"outbounds":[{"type":"vmess","tag":"V","server":"proxy.example","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","alter_id":64}]}`,
	} {
		if _, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "sing-box", Data: []byte(body)}); err == nil {
			t.Fatal("cross-protocol/legacy field ignored")
		}
	}
}

func TestHysteria2ShareLinkAndUnsupportedOptions(t *testing.T) {
	req := Request{SourceID: "source", OwnerID: "alice", SnapshotID: "snapshot", Format: "uri-list", Data: []byte("hy2://fixture-password@proxy.example:443/?sni=proxy.example&alpn=h3#HY2")}
	result, err := Parse(req)
	if err != nil {
		t.Fatal(err)
	}
	c := result.Snapshot.Endpoints[0].Connection
	if c.Protocol != "hysteria2" || c.Password != "fixture-password" || c.TLS == nil || !c.TLS.Enabled || c.TLS.ServerName != "proxy.example" {
		t.Fatal("HY2 link lost settings")
	}
	for _, raw := range []string{
		"hy2://fixture-password@proxy.example:443/?insecure=1",
		"hy2://fixture-password@proxy.example:443/?obfs=salamander&obfs-password=secret",
	} {
		req.Data = []byte(raw)
		r, e := Parse(req)
		if e == nil || len(r.Snapshot.Endpoints) > 0 {
			t.Fatal("unsupported URI silently weakened")
		}
	}
	req.Format = "sing-box"
	req.Data = []byte(`{"outbounds":[{"type":"hysteria2","tag":"HY2","server":"proxy.example","server_port":443,"password":"fixture-password","tls":{"enabled":true},"up_mbps":10}]}`)
	if _, err := Parse(req); err == nil {
		t.Fatal("unmodeled bandwidth silently discarded")
	}
}

func TestHysteria2ImportRejectsEmptyUTLS(t *testing.T) {
	_, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "sing-box", Data: []byte(`{"outbounds":[{"type":"hysteria2","server":"proxy.example","server_port":443,"password":"fixture","tls":{"enabled":true,"utls":{"enabled":true}}}]}`)})
	if err == nil {
		t.Fatal("unmodeled uTLS silently discarded")
	}
}

func TestHysteria2ShareLinkDefaultPort(t *testing.T) {
	for _, link := range []string{"hy2://fixture@proxy.example", "hysteria2://fixture@proxy.example"} {
		r, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "uri-list", Data: []byte(link)})
		if err != nil || len(r.Snapshot.Endpoints) != 1 || r.Snapshot.Endpoints[0].Connection.Port != 443 {
			t.Fatalf("default port: %v", err)
		}
	}
	for _, link := range []string{"hy2://fixture@proxy.example:", "hy2://fixture@proxy.example:0", "hy2://fixture@proxy.example:65536"} {
		if _, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: "uri-list", Data: []byte(link)}); err == nil {
			t.Fatal("invalid port accepted")
		}
	}
}

func TestAnyTLSShareURIKeepsPasswordNameAndTLS(t *testing.T) {
	for _, raw := range []string{
		"anytls://p%3Aa%40ss@proxy.example/?sni=tls.example&insecure=0#My%20node",
		"anytls://p%3Aa%40ss@[2001:db8::1]/?sni=tls.example#My%20node",
	} {
		r, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snapshot", Format: "uri-list", Data: []byte(raw)})
		if err != nil {
			t.Fatal(err)
		}
		e := r.Snapshot.Endpoints[0]
		if e.Name != "My node" || e.Connection.Protocol != "anytls" || e.Connection.Password != "p:a@ss" || e.Connection.Port != 443 || e.Connection.TLS == nil || !e.Connection.TLS.Enabled || e.Connection.TLS.ServerName != "tls.example" {
			t.Fatal("AnyTLS link lost semantics")
		}
	}
	for _, serverName := range []string{"127.0.0.1", "2001:db8::1"} {
		r, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snapshot", Format: "uri-list", Data: []byte("anytls://pass@proxy.example:8443/?sni=" + serverName)})
		if err != nil {
			t.Fatal(err)
		}
		if r.Snapshot.Endpoints[0].Connection.Port != 8443 || r.Snapshot.Endpoints[0].Connection.TLS.ServerName != serverName {
			t.Fatal("IP certificate identity or explicit port changed")
		}
	}
	for _, raw := range []string{
		"anytls://pass@proxy.example/?insecure=1", "anytls://pass@proxy.example/?insecure=true", "anytls://pass@proxy.example/?insecure=",
		"anytls://user:pass@proxy.example/", "anytls://pass@proxy.example/?sni=a&sni=b", "anytls://pass@proxy.example/?alpn=h3", "anytls://pass@proxy.example/path", "anytls://pass@proxy.example:0", "anytls://pass@proxy.example:",
	} {
		r, err := Parse(Request{SourceID: "source", OwnerID: "u", SnapshotID: "snapshot", Format: "uri-list", Data: []byte(raw)})
		if err == nil || len(r.Snapshot.Endpoints) != 0 {
			t.Fatal("unsupported AnyTLS URI accepted or partially imported")
		}
	}
}
