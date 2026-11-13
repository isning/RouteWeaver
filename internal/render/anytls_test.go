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
	for _, edge := range []int{0, 1} {
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
