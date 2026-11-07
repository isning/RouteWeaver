package importer_test

import (
	"strings"
	"testing"

	"routeweaver/internal/importer"
)

func TestParseRejectsAliasedTLSFieldsWithoutUsableSnapshot(t *testing.T) {
	result, err := importer.Parse(importer.Request{
		SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: "sing-box",
		Data: []byte(`{"outbounds":[{"type":"vless","tag":"Synthetic TLS","server":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","tls":{"enabled":true,"ENABLED":false}}]}`),
	})
	if err == nil || result.Complete || len(result.Snapshot.Endpoints) != 0 {
		t.Fatal("ambiguous TLS fields returned a usable imported snapshot")
	}
}

func TestParseRejectsAliasedConnectionSettingsAcrossNativeFormats(t *testing.T) {
	for _, input := range []struct{ name, format, data string }{
		{"destination", "sing-box", `{"outbounds":[{"type":"socks","server":"accepted.example.test","SERVER":"other.example.test","server_port":1080}]}`},
		{"destination reversed", "sing-box", `{"outbounds":[{"type":"socks","SERVER":"other.example.test","server":"accepted.example.test","server_port":1080}]}`},
		{"credential", "sing-box", `{"outbounds":[{"type":"shadowsocks","server":"proxy.example.test","server_port":443,"method":"aes-128-gcm","password":"synthetic-old-secret","PASSWORD":"synthetic-new-secret"}]}`},
		{"TLS object", "sing-box", `{"outbounds":[{"type":"vless","server":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","tls":{"enabled":true},"TLS":null}]}`},
		{"transport path", "sing-box", `{"outbounds":[{"type":"vless","server":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","transport":{"type":"ws","path":"/accepted","PATH":"/other"}}]}`},
		{"Unicode fold", "sing-box", `{"outbounds":[{"type":"socks","server":"accepted.example.test","\u017ferver":"other.example.test","server_port":1080}]}`},
		{"JSON native node", "mihomo", `{"proxies":[{"type":"socks5","server":"accepted.example.test","SERVER":"other.example.test","port":1080}]}`},
		{"YAML native node", "mihomo", "proxies:\n  - type: vless\n    server: proxy.example.test\n    port: 443\n    uuid: 00000000-0000-4000-8000-000000000001\n    tls: true\n    TLS: false\n"},
	} {
		t.Run(input.name, func(t *testing.T) {
			result, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: input.format, Data: []byte(input.data)})
			if err == nil || result.Complete || len(result.Snapshot.Endpoints) != 0 {
				t.Fatal("ambiguous typed settings returned a usable imported snapshot")
			}
			if strings.Contains(err.Error(), "synthetic-old-secret") || strings.Contains(err.Error(), "synthetic-new-secret") {
				t.Fatal("rejection disclosed source credentials")
			}
		})
	}
}

func TestParseRejectsAliasedOutboundTypeBeforePolicyExtraction(t *testing.T) {
	for _, fields := range []string{`"type":"socks","TYPE":"direct"`, `"TYPE":"direct","type":"socks"`} {
		result, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: "sing-box", Data: []byte(`{"outbounds":[{` + fields + `,"server":"proxy.example.test","server_port":1080}]}`)})
		if err == nil || result.Complete || len(result.Snapshot.Endpoints) != 0 {
			t.Fatal("ambiguous outbound type was omitted as a built-in policy")
		}
	}
}

func TestParsePreservesUnambiguousTypedNamesAndCaseSensitiveMaps(t *testing.T) {
	for _, input := range []struct{ name, format, data string }{
		{"canonical", "sing-box", `{"outbounds":[{"type":"vless","server":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","tls":{"enabled":true}}],"route":{"Rule":"upper","rule":"lower"}}`},
		{"single alias", "sing-box", `{"outbounds":[{"type":"vless","SERVER":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","TLS":{"ENABLED":true}}],"route":{"Rule":"upper","rule":"lower"}}`},
		{"canonical YAML", "mihomo", "proxies:\n  - type: vless\n    server: proxy.example.test\n    port: 443\n    uuid: 00000000-0000-4000-8000-000000000001\n    tls: true\nmetadata:\n  Rule: upper\n  rule: lower\n"},
	} {
		t.Run(input.name, func(t *testing.T) {
			result, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: input.format, Data: []byte(input.data)})
			if err != nil || !result.Complete || len(result.Snapshot.Endpoints) != 1 {
				t.Fatal("unambiguous native connection was rejected")
			}
			connection := result.Snapshot.Endpoints[0].Connection
			if connection.Host != "proxy.example.test" || connection.TLS == nil || !connection.TLS.Enabled {
				t.Fatal("valid destination or TLS setting changed during import")
			}
		})
	}
}
