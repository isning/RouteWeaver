package importer

import (
	"strings"
	"testing"
)

// These are finite boundary cases at Parse, not a fuzzing or memory proof.
func TestParseRejectsOversizeAndAmbiguousDocumentsWithoutPartialSnapshot(t *testing.T) {
	cases := []struct{ name, format, content string }{
		{"input bytes", "uri-list", strings.Repeat("x", (16<<20)+1)},
		{"URI line", "uri-list", "socks5://proxy.example:1080#" + strings.Repeat("x", 65536)},
		{"URI line count", "uri-list", strings.Repeat("# comment\n", 20001) + "socks5://proxy.example:1080"},
		{"native connection count", "sing-box", `{"outbounds":[` + strings.Repeat(`{"type":"direct"},`, 10000) + `{"type":"direct"}]}`},
		{"JSON nesting", "sing-box", `{"outbounds":[],"ignored":` + strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66) + "}"},
		{"duplicate YAML key", "mihomo", "proxies: []\nproxies: []\n"},
		{"multiple YAML documents", "mihomo", "proxies: []\n---\nproxies: []\n"},
		{"recursive YAML alias", "mihomo", "proxies: &self [*self]\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := Parse(Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: tc.format, Data: []byte(tc.content)})
			if err == nil || result.Complete || len(result.Snapshot.Endpoints) != 0 {
				t.Fatal("invalid input returned a usable candidate")
			}
		})
	}
}
