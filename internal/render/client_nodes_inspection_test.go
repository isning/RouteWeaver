package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestNodesInspectionBoundsAggregateValuesBeforeOptionalComparison(t *testing.T) {
	// A byte-small but value-large array must not exhaust inspection heap. This
	// comparison limit does not change whether the original output can publish.
	body := `{"outbounds":[{"type":"vless","tag":"Alpha","server":"example.org","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","tls":{"enabled":true,"alpn":[` + strings.Repeat(`"",`, 1_000_000) + `""]}}]}`
	_, err := render.InspectNodesOnly(render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.NodesOnly, []domain.Artifact{{Path: "sing-box-nodes.json", Content: body}}, map[string]domain.NameAllocation{"node": {DisplayName: "Alpha", OutputName: "Alpha"}})
	if err == nil {
		t.Fatal("value-heavy inspection must return unavailable rather than allocate unbounded arrays")
	}
}

func TestNodesInspectionMatchesActualPortableEmission(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
				p := clientProfile()
				p.Endpoints = append(p.Endpoints, domain.ClientEndpoint{ID: "vless", Name: "Vless", OwnerID: p.OwnerID, Origin: "imported", Connection: domain.Connection{Protocol: "vless", Host: "vless.example", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, Fingerprint: "chrome", ALPN: []string{"h2"}}, Transport: &domain.TransportOptions{Type: transport}}})
				rendered, err := render.DefaultClients().Render(p, target, render.NodesOnly)
				if err != nil {
					t.Fatal(err)
				}
				nodes, err := render.InspectNodesOnly(target, render.NodesOnly, rendered.Artifacts, rendered.NameAllocations)
				if err != nil || len(nodes) != 3 {
					t.Fatalf("valid %s unavailable", transport)
				}
				if nodes[2].ID() != "vless" || nodes[2].Name() != "Vless" {
					t.Fatal("identity association lost")
				}
				wire, _ := json.Marshal(nodes)
				for _, value := range []string{"vless", "Vless", "synthetic-fixture-secret", "00000000"} {
					if strings.Contains(string(wire), value) {
						t.Fatal("private inspector accidentally serializable")
					}
				}
				p.Endpoints[2].Connection.TLS.Fingerprint = "Chrome"
				next, err := render.DefaultClients().Render(p, target, render.NodesOnly)
				if err != nil {
					t.Fatal(err)
				}
				now, err := render.InspectNodesOnly(target, render.NodesOnly, next.Artifacts, next.NameAllocations)
				if err != nil || !nodes[2].SameSettings(now[2]) {
					t.Fatal("normalization treated as settings change")
				}
			}
		})
	}
}

func TestNodesInspectionRejectsUnverifiedFrozenAssociation(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	base := `{"proxies":[{"name":"Alpha","type":"socks5","server":"alpha.example","port":1080}]}`
	for _, bad := range []string{
		strings.Replace(base, `"port":1080`, `"port":1080,"port":1081`, 1),
		strings.Replace(base, `"port":1080`, `"port":1.08e3`, 1),
		strings.Replace(base, `"port":1080`, `"port":65536`, 1),
		strings.Replace(base, `"port":1080`, `"port":1080,"extra":true`, 1),
		strings.Replace(base, `"Alpha"`, `"Other"`, 1),
		`{"proxies":null}`, base + `{}`, strings.Replace(base, `"proxies"`, `"outbounds"`, 1),
		strings.Replace(base, `"port":1080`, `"port":`+strings.Repeat(`[`, 18)+`0`+strings.Repeat(`]`, 18), 1),
	} {
		_, err := render.InspectNodesOnly(target, render.NodesOnly, []domain.Artifact{{Path: "mihomo-nodes.json", Content: bad}}, map[string]domain.NameAllocation{"node": {OutputName: "Alpha"}})
		if err == nil {
			t.Fatal("unverified artifact accepted")
		}
	}
	for _, alloc := range []map[string]domain.NameAllocation{nil, {"node": {OutputName: "Alpha"}, "other": {OutputName: "Alpha"}}, {"bad id": {OutputName: "Alpha"}}, {"node": {OutputName: "Alpha"}, "other": {OutputName: "Beta"}}} {
		if _, err := render.InspectNodesOnly(target, render.NodesOnly, []domain.Artifact{{Path: "mihomo-nodes.json", Content: base}}, alloc); err == nil {
			t.Fatal("non-bijective allocation accepted")
		}
	}
	nodes, err := render.InspectNodesOnly(target, render.NodesOnly, []domain.Artifact{{Path: "mihomo-nodes.json", Content: `{"proxies":[]}`}}, nil)
	if err != nil || len(nodes) != 0 {
		t.Fatal("complete empty became unavailable")
	}
}
