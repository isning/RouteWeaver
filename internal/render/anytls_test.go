package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func anyTLSConnection() domain.Connection {
	return domain.Connection{Protocol: "anytls", Host: "proxy.example", Port: 443, Password: "synthetic-anytls-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "proxy.example"}}
}

func TestAnyTLSDirectRoundtripAndBoundaries(t *testing.T) {
	p := clientProfile()
	p.Endpoints = p.Endpoints[:1]
	p.Endpoints[0].Connection = anyTLSConnection()
	p.Groups = nil
	p.Rules = nil
	for _, mode := range []render.OutputMode{render.NodesOnly, render.FullConfig} {
		got, err := render.DefaultClients().Render(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, mode)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := importer.Parse(importer.Request{OwnerID: "u", SourceID: "s", SnapshotID: "snap", Format: "sing-box", Data: []byte(got.Artifacts[0].Content)})
		if err != nil {
			t.Fatal(err)
		}
		a, _ := json.Marshal(parsed.Snapshot.Endpoints[0].Connection)
		b, _ := json.Marshal(p.Endpoints[0].Connection)
		if string(a) != string(b) {
			t.Fatal("AnyTLS import lost connection options")
		}
	}
	if _, err := render.DefaultClients().Render(p, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, render.NodesOnly); err == nil {
		t.Fatal("unsupported client accepted")
	}
	ir := serverIR(render.ServerAdapterSingBox, render.StockSingBoxVersion)
	program := &ir.Programs[0]
	program.Listener.Connection = anyTLSConnection()
	program.Listener.Connection.Host = "127.0.0.1"
	cert, key := serverCertificate(t)
	program.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: cert, PrivateKeyPEM: key}
	out, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out[0].Content, `"type": "anytls"`) || !strings.Contains(out[0].Content, `"password": "synthetic-anytls-password"`) {
		t.Fatal("missing AnyTLS listener credentials")
	}
	program.Instance.AdapterID = render.ServerAdapterXray
	program.Instance.Version = render.StockXrayVersion
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("Xray accepted AnyTLS")
	}
	program.Instance.AdapterID = render.ServerAdapterSingBox
	program.Instance.Version = render.StockSingBoxVersion
	program.Egress = nil
	program.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "a"}
	program.Connectors = []domain.ServerConnector{{ID: "a", Connection: anyTLSConnection()}, {ID: "b", Connection: domain.Connection{Protocol: "socks", Host: "proxy.example", Port: 1080}}}
	for _, edge := range []int{1} {
		program.Connectors[0].Via = ""
		program.Connectors[1].Via = ""
		program.Connectors[edge].Via = program.Connectors[1-edge].ID
		if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
			t.Fatalf("unverified AnyTLS detour accepted or wrong rejection: %v", err)
		}
	}
}

func TestAnyTLSRejectsUnmodeledSecurity(t *testing.T) {
	for _, change := range []func(*domain.Connection){func(c *domain.Connection) { c.Password = "" }, func(c *domain.Connection) { c.TLS = nil }, func(c *domain.Connection) { c.TLS.Fingerprint = "chrome" }, func(c *domain.Connection) { c.Transport = &domain.TransportOptions{Type: "tcp"} }, func(c *domain.Connection) { c.UUID = "irrelevant" }} {
		c := anyTLSConnection()
		change(&c)
		if domain.ValidateConnection(c) == nil {
			t.Fatal("unsupported settings accepted")
		}
	}
	for _, extra := range []string{`,"tls":{"enabled":true},"idle_session_timeout":"10s"`, `,"tls":{"enabled":true,"utls":{"enabled":true}}`} {
		body := `{"outbounds":[{"type":"anytls","server":"proxy.example","server_port":443,"password":"fixture"` + extra + `}]}`
		if _, err := importer.Parse(importer.Request{OwnerID: "u", SourceID: "s", SnapshotID: "snap", Format: "sing-box", Data: []byte(body)}); err == nil {
			t.Fatal("unmodeled native parameter discarded")
		}
	}
}

func TestAnyTLSViaDirectSOCKSCompilesWithoutChangingExit(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.StockSingBoxVersion)
	p := &ir.Programs[0]
	p.Egress = nil
	p.Connectors = []domain.ServerConnector{{ID: "exit", Connection: anyTLSConnection(), Via: "relay"}, {ID: "relay", Connection: domain.Connection{Protocol: "socks", Host: "relay.example", Port: 1080}}}
	p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "exit"}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err = json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
		t.Fatal(err)
	}
	if config["route"].(map[string]any)["final"] != "exit" {
		t.Fatal("forwarding action changed from AnyTLS exit")
	}
	found := false
	for _, raw := range config["outbounds"].([]any) {
		o := raw.(map[string]any)
		if o["tag"] == "exit" {
			found = true
			if o["type"] != "anytls" || o["detour"] != "relay" || o["server"] != "proxy.example" {
				t.Fatal("AnyTLS exit or relay changed")
			}
		}
	}
	if !found {
		t.Fatal("exit missing")
	}
	p.Connectors = append(p.Connectors, domain.ServerConnector{ID: "third", Connection: domain.Connection{Protocol: "socks", Host: "third.example", Port: 1080}})
	p.Connectors[1].Via = "third"
	if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
		t.Fatal("extra hop accepted")
	}
	p.Connectors[1].Via = ""
	p.Connectors[1].Connection = anyTLSConnection()
	if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
		t.Fatal("unsupported upstream accepted")
	}
	p.Connectors = nil
	p.Egress = []domain.Connection{{Protocol: "socks", Host: "relay.example", Port: 1080}, anyTLSConnection()}
	p.DefaultAction = domain.ActionRef{}
	if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
		t.Fatal("legacy chain accepted")
	}
}

func TestAnyTLSViaTrojanPreservesBothTLSIdentities(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.StockSingBoxVersion)
	p := &ir.Programs[0]
	p.Egress = nil
	relay := domain.Connection{Protocol: "trojan", Host: "relay.example", Port: 443, Password: "synthetic-relay-secret", TLS: &domain.TLSOptions{Enabled: true, ServerName: "relay-tls.example"}}
	p.Connectors = []domain.ServerConnector{{ID: "exit", Connection: anyTLSConnection(), Via: "relay"}, {ID: "relay", Connection: relay}}
	p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "exit"}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err = json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
		t.Fatal(err)
	}
	if config["route"].(map[string]any)["final"] != "exit" {
		t.Fatal("final exit changed")
	}
	seen := map[string]bool{}
	for _, raw := range config["outbounds"].([]any) {
		o := raw.(map[string]any)
		tag, _ := o["tag"].(string)
		if tag != "exit" && tag != "relay" {
			continue
		}
		seen[tag] = true
		tls := o["tls"].(map[string]any)
		if tag == "exit" && (o["detour"] != "relay" || o["type"] != "anytls" || tls["server_name"] != "proxy.example") {
			t.Fatal("exit identity changed")
		}
		if tag == "relay" && (o["type"] != "trojan" || o["password"] != "synthetic-relay-secret" || tls["server_name"] != "relay-tls.example") {
			t.Fatal("relay identity changed")
		}
	}
	if len(seen) != 2 {
		t.Fatal("missing chain node")
	}
	for _, bad := range []func(*domain.Connection){func(c *domain.Connection) { c.Transport = &domain.TransportOptions{Type: "ws"} }, func(c *domain.Connection) {
		c.TLS = &domain.TLSOptions{Enabled: true, ServerName: "relay.example", Fingerprint: "chrome"}
	}} {
		c := relay
		bad(&c)
		p.Connectors[1].Connection = c
		if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
			t.Fatalf("unverified relay accepted: %v", err)
		}
	}
}

func TestAnyTLSTwoTrojanRelaysKeepOrderAndRejectExtraOrMixedHops(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.StockSingBoxVersion)
	p := &ir.Programs[0]
	p.Egress = nil
	relay := domain.Connection{Protocol: "trojan", Host: "relay.example", Port: 443, Password: "synthetic-secret", TLS: &domain.TLSOptions{Enabled: true, ServerName: "relay.example"}}
	p.Connectors = []domain.ServerConnector{{ID: "exit", Connection: anyTLSConnection(), Via: "second"}, {ID: "second", Connection: relay, Via: "first"}, {ID: "first", Connection: relay}}
	p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "exit"}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err = json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{"exit": "second", "second": "first", "first": ""}
	seen := 0
	for _, raw := range config["outbounds"].([]any) {
		o := raw.(map[string]any)
		tag, _ := o["tag"].(string)
		want, ok := expected[tag]
		if !ok {
			continue
		}
		seen++
		got, _ := o["detour"].(string)
		if got != want {
			t.Fatal("relay order changed")
		}
	}
	if seen != 3 || config["route"].(map[string]any)["final"] != "exit" {
		t.Fatal("chain missing or exit changed")
	}
	p.Connectors = append(p.Connectors, domain.ServerConnector{ID: "extra", Connection: relay})
	p.Connectors[2].Via = "extra"
	if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
		t.Fatal("third relay accepted")
	}
	p.Connectors[2].Via = ""
	p.Connectors[2].Connection = domain.Connection{Protocol: "socks", Host: "relay.example", Port: 1080}
	if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "ANYTLS_DETOUR_UNSUPPORTED") {
		t.Fatal("mixed two-relay chain accepted")
	}
}
