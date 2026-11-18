package httpapi_test

import (
	"encoding/json"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestCompletedProtocolSourcePublication(t *testing.T) {
	for _, protocol := range []string{"hysteria2", "anytls", "tuic"} {
		for _, adapter := range []string{"mihomo", "sing-box"} {
			t.Run(protocol+"/"+adapter, func(t *testing.T) {
				s, srv := makeServer(t)
				owner := inviteClient(t, s, srv, "protocol-owner")
				other := inviteClient(t, s, srv, "protocol-other")
				node := map[string]any{"type": protocol, "name": "Private node", "server": "proxy.example", "port": 443, "password": "synthetic-main", "sni": "proxy.example", "udp": true, "skip-cert-verify": false}
				if protocol == "hysteria2" {
					node["obfs"] = "salamander"
					node["obfs-password"] = "synthetic-obfs"
					node["ports"] = "443,10000-20000"
					node["hop-interval"] = 30
					node["up"] = "100 Mbps"
				}
				if protocol == "tuic" {
					node["uuid"] = "00000000-0000-4000-8000-000000000001"
					node["congestion-controller"] = "bbr"
					node["udp-relay-mode"] = "native"
				}
				data, _ := json.Marshal(map[string]any{"proxies": []any{node}})
				source := map[string]any{"id": "protocol-source", "name": "Private source", "kind": "text", "format": "mihomo", "content": string(data), "enabled": true}
				code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, source)
				var accepted httpapi.Source
				if code != 200 || json.Unmarshal([]byte(raw), &accepted) != nil || accepted.Snapshot == nil || len(accepted.Snapshot.Endpoints) != 1 {
					t.Fatalf("import failed: %d %s", code, raw)
				}
				id := accepted.Snapshot.Endpoints[0].ID
				if strings.Contains(raw, "synthetic-") {
					t.Fatal("save response leaked credentials")
				}
				code, _, raw = req(t, other.c, "GET", srv.URL+"/api/me/sources/protocol-source/reveal", "", nil)
				if code != 404 || strings.Contains(raw, "synthetic-") {
					t.Fatal("cross-account source exposure")
				}
				version := render.MihomoVersion
				if adapter == "sing-box" {
					version = render.StockSingBoxVersion
				}
				profile := httpapi.Profile{ID: "protocol-profile", Name: "Protocol profile", Target: render.Target{AdapterID: adapter, Version: version}, Mode: render.FullConfig, SourceIDs: []string{"protocol-source"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: id}}}
				code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile)
				if code != 200 {
					t.Fatalf("save profile: %d %s", code, raw)
				}
				code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/profiles/protocol-profile/preview", owner.csrf, map[string]any{"target": profile.Target, "mode": "full"})
				if code != 200 || strings.Contains(raw, "synthetic-") {
					t.Fatalf("preview failed or leaked: %d %s", code, raw)
				}
				code, output, raw := req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "protocol-output", "name": "Protocol", "profileId": profile.ID, "target": profile.Target, "mode": "full"})
				if code != 201 {
					t.Fatalf("publish: %d %s", code, raw)
				}
				feed, ok := output["feedPath"].(string)
				if !ok {
					t.Fatal("missing feed path")
				}
				code, _, raw = req(t, http.DefaultClient, "GET", srv.URL+feed, "", nil)
				if code != 200 {
					t.Fatalf("download: %d", code)
				}
				parsed, err := importer.Parse(importer.Request{SourceID: "s", OwnerID: "u", SnapshotID: "ss", Format: adapter, Data: []byte(raw)})
				if err != nil || len(parsed.Snapshot.Endpoints) != 1 {
					t.Fatal("download lost connection", err)
				}
				c := parsed.Snapshot.Endpoints[0].Connection
				if c.Protocol != protocol || c.Password != "synthetic-main" {
					t.Fatal("published protocol or password changed")
				}
				if protocol == "hysteria2" && (c.Hysteria2 == nil || c.Hysteria2.Obfs == nil || c.Hysteria2.Obfs.Password != "synthetic-obfs" || c.Hysteria2.UpMbps != 100 || len(c.Hysteria2.ServerPorts) != 2) {
					t.Fatal("published HY2 parameters lost")
				}
				if protocol == "tuic" && (c.UUID != "00000000-0000-4000-8000-000000000001" || c.TUIC == nil || c.TUIC.CongestionControl != "bbr") {
					t.Fatal("published TUIC parameters lost")
				}
			})
		}
	}
}
