package render_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"slices"
	"testing"
)

func TestPasswordTLSMihomoAndSingBoxRoundtrip(t *testing.T) {
	for _, protocol := range []string{"hysteria2", "anytls", "tuic"} {
		for _, adapter := range []string{"mihomo", "sing-box"} {
			t.Run(protocol+"/"+adapter, func(t *testing.T) {
				p := clientProfile()
				p.Endpoints = p.Endpoints[:1]
				p.Groups = nil
				p.Rules = nil
				p.Endpoints[0].Connection = domain.Connection{Protocol: protocol, Host: "proxy.example", Port: 443, Password: "synthetic", TLS: &domain.TLSOptions{Enabled: true, ServerName: "proxy.example"}}
				if protocol == "tuic" {
					p.Endpoints[0].Connection.UUID = "00000000-0000-4000-8000-000000000001"
				}
				version := render.SingBoxVersion
				if adapter == "mihomo" {
					version = render.MihomoVersion
				}
				r, err := render.DefaultClients().Render(p, render.Target{AdapterID: adapter, Version: version}, render.NodesOnly)
				if err != nil {
					t.Fatal(err)
				}
				parsed, err := importer.Parse(importer.Request{SourceID: "s", OwnerID: "u", SnapshotID: "ss", Format: adapter, Data: []byte(r.Artifacts[0].Content)})
				if err != nil {
					t.Fatal(err)
				}
				a, _ := json.Marshal(p.Endpoints[0].Connection)
				b, _ := json.Marshal(parsed.Snapshot.Endpoints[0].Connection)
				if !reflect.DeepEqual(a, b) {
					t.Fatalf("connection changed: %s != %s", a, b)
				}
			})
		}
	}
}

func TestHysteria2OptionsAcrossClientFormats(t *testing.T) {
	for _, adapter := range []string{"mihomo", "sing-box"} {
		t.Run(adapter, func(t *testing.T) {
			p := clientProfile()
			p.Endpoints = p.Endpoints[:1]
			p.Groups = nil
			p.Rules = nil
			c := hysteria2Connection()
			c.Hysteria2 = &domain.Hysteria2Options{Obfs: &domain.ObfuscationOptions{Type: "salamander", Password: "synthetic-obfs"}, UpMbps: 100, DownMbps: 200, ServerPorts: []string{"443", "10000:20000"}, HopIntervalSeconds: 30}
			p.Endpoints[0].Connection = c
			version := render.SingBoxVersion
			if adapter == "mihomo" {
				version = render.MihomoVersion
			}
			r, err := render.DefaultClients().Render(p, render.Target{AdapterID: adapter, Version: version}, render.NodesOnly)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := importer.Parse(importer.Request{SourceID: "s", OwnerID: "u", SnapshotID: "ss", Format: adapter, Data: []byte(r.Artifacts[0].Content)})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(parsed.Snapshot.Endpoints[0].Connection, c) {
				t.Fatal("HY2 options changed during roundtrip")
			}
			inspected, err := render.InspectNodesOnly(render.Target{AdapterID: adapter, Version: version}, render.NodesOnly, r.Artifacts, r.NameAllocations)
			if err != nil || len(inspected) != 1 || !slices.Contains(inspected[0].ProtectedStrings(), "synthetic-obfs") {
				t.Fatal("inspection failed to protect obfuscation password", err)
			}
		})
	}
}

func TestShadowsocks2022ClientRoundtrip(t *testing.T) {
	for _, method := range []string{"2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"} {
		for _, adapter := range []string{"mihomo", "sing-box"} {
			t.Run(method+"/"+adapter, func(t *testing.T) {
				key := "AAAAAAAAAAAAAAAAAAAAAA=="
				if method != "2022-blake3-aes-128-gcm" {
					key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
				}
				p := clientProfile()
				p.Endpoints = p.Endpoints[:1]
				p.Groups = nil
				p.Rules = nil
				c := domain.Connection{Protocol: "shadowsocks", Host: "proxy.example", Port: 443, Method: method, Password: key}
				p.Endpoints[0].Connection = c
				version := render.SingBoxVersion
				if adapter == "mihomo" {
					version = render.MihomoVersion
				}
				r, err := render.DefaultClients().Render(p, render.Target{AdapterID: adapter, Version: version}, render.NodesOnly)
				if err != nil {
					t.Fatal(err)
				}
				parsed, err := importer.Parse(importer.Request{SourceID: "s", OwnerID: "u", SnapshotID: "ss", Format: adapter, Data: []byte(r.Artifacts[0].Content)})
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(parsed.Snapshot.Endpoints[0].Connection, c) {
					t.Fatal("SS2022 key/method changed")
				}
				c.Password = "invalid"
				if domain.ValidateConnection(c) == nil {
					t.Fatal("invalid SS2022 key accepted")
				}
			})
		}
	}
}

func TestXHTTPImportAndTargetGuard(t *testing.T) {
	r, err := importer.Parse(importer.Request{SourceID: "s", OwnerID: "u", SnapshotID: "ss", Format: "uri-list", Data: []byte("vless://00000000-0000-4000-8000-000000000001@proxy.example:443?type=xhttp&path=%2Fproxy&mode=packet-up")})
	if err != nil {
		t.Fatal(err)
	}
	c := r.Snapshot.Endpoints[0].Connection
	if c.Transport == nil || c.Transport.Mode != "packet-up" {
		t.Fatal("XHTTP mode lost")
	}
	p := clientProfile()
	p.Endpoints = p.Endpoints[:1]
	p.Endpoints[0].Connection = c
	p.Groups = nil
	p.Rules = nil
	for _, adapter := range []string{"mihomo", "sing-box"} {
		version := render.SingBoxVersion
		if adapter == "mihomo" {
			version = render.MihomoVersion
		}
		if _, err := render.DefaultClients().Render(p, render.Target{AdapterID: adapter, Version: version}, render.NodesOnly); err == nil {
			t.Fatal("XHTTP silently accepted by incompatible target")
		}
	}
}
