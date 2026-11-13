package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func hysteria2Connection() domain.Connection {
	return domain.Connection{Protocol: "hysteria2", Host: "proxy.example", Port: 443, Password: "synthetic-hy2-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "proxy.example", ALPN: []string{"h3"}}}
}
func TestHysteria2DirectSingBoxClientRoundtrip(t *testing.T) {
	p := clientProfile()
	p.Endpoints = p.Endpoints[:1]
	p.Endpoints[0].Connection = hysteria2Connection()
	p.Groups = nil
	p.Rules = nil
	for _, mode := range []render.OutputMode{render.NodesOnly, render.FullConfig} {
		got, err := render.DefaultClients().Render(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, mode)
		if err != nil {
			t.Fatal(err)
		}
		imported, err := importer.Parse(importer.Request{OwnerID: "u", SourceID: "source", SnapshotID: "snapshot", Format: "sing-box", Data: []byte(got.Artifacts[0].Content)})
		if err != nil {
			t.Fatal(err)
		}
		if len(imported.Snapshot.Endpoints) != 1 {
			t.Fatal("missing imported connection")
		}
		a, _ := json.Marshal(imported.Snapshot.Endpoints[0].Connection)
		b, _ := json.Marshal(p.Endpoints[0].Connection)
		if string(a) != string(b) {
			t.Fatal("roundtrip lost HY2 fields")
		}
	}
	if _, err := render.DefaultClients().Render(p, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, render.NodesOnly); err == nil {
		t.Fatal("unimplemented output accepted HY2")
	}
}
func TestHysteria2ServerDirectAndTargetBoundaries(t *testing.T) {
	ir := serverIR(render.ServerAdapterSingBox, render.StockSingBoxVersion)
	p := &ir.Programs[0]
	p.Egress = nil
	p.Listener.Connection = hysteria2Connection()
	p.Listener.Connection.Host = "127.0.0.1"
	cert, key := serverCertificate(t)
	p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: cert, PrivateKeyPEM: key}
	got, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got[0].Content, `"type": "hysteria2"`) || !strings.Contains(got[0].Content, `"password": "synthetic-hy2-password"`) || strings.Contains(got[0].Content, `"uuid"`) {
		t.Fatal("invalid HY2 listener")
	}
	p.Instance.AdapterID = render.ServerAdapterXray
	p.Instance.Version = render.StockXrayVersion
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("Xray accepted HY2")
	}
	p.Instance.AdapterID = render.ServerAdapterSingBox
	p.Instance.Version = render.StockSingBoxVersion
	p.Connectors = []domain.ServerConnector{{ID: "hy2", Connection: hysteria2Connection()}, {ID: "tcp", Connection: domain.Connection{Protocol: "socks", Host: "proxy.example", Port: 1080}}}
	p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "hy2"}
	for _, edge := range []int{0, 1} {
		p.Connectors[0].Via = ""
		p.Connectors[1].Via = ""
		p.Connectors[edge].Via = p.Connectors[1-edge].ID
		if _, err = render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "HYSTERIA2_DETOUR_UNSUPPORTED") {
			t.Fatalf("detour accepted: %v", err)
		}
	}
}

func TestHysteria2RejectsUnsupportedSettingsAndTargets(t *testing.T) {
	for _, change := range []func(*domain.Connection){
		func(c *domain.Connection) { c.Password = "" }, func(c *domain.Connection) { c.UUID = "not-hy2" },
		func(c *domain.Connection) { c.TLS = nil }, func(c *domain.Connection) { c.TLS.Fingerprint = "chrome" },
		func(c *domain.Connection) { c.TLS.ALPN = []string{"http/1.1"} }, func(c *domain.Connection) { c.Transport = &domain.TransportOptions{Type: "tcp"} },
	} {
		c := hysteria2Connection()
		change(&c)
		if domain.ValidateConnection(c) == nil {
			t.Fatal("unsupported HY2 option accepted")
		}
	}
	c := hysteria2Connection()
	n := domain.Node{ID: "hy2", Name: "HY2", Host: c.Host, Port: c.Port, Protocol: c.Protocol, Password: c.Password, TLS: c.TLS}
	r := domain.Route{ID: "route", Name: "Route", Engine: "sing-box", Hops: []string{"hy2"}}
	if _, err := (render.SingBox{}).Render(r, []domain.Node{n}); err != nil {
		t.Fatal(err)
	}
	if _, err := (render.Xray{}).Render(r, []domain.Node{n}); err == nil {
		t.Fatal("direct Xray renderer accepted HY2")
	}
	if _, err := (render.SingBox{}).Render(r, []domain.Node{n, n}); err == nil {
		t.Fatal("legacy HY2 detour accepted")
	}
}
