package render_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func trojanConnection(transport string) domain.Connection {
	c := domain.Connection{Host: "proxy.example", Port: 443, Protocol: "trojan", Password: "trojan-fixture", TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls.example", Fingerprint: "chrome"}, Transport: &domain.TransportOptions{Type: transport}}
	switch transport {
	case "ws", "httpupgrade":
		c.Transport.Path = "/proxy"
		c.Transport.Host = "cdn.example"
		c.Transport.Headers = map[string]string{"X-Client": "fixture"}
	case "grpc":
		c.Transport.ServiceName = "proxy"
	}
	return c
}
func TestTrojanClientImportRenderRoundtrip(t *testing.T) {
	for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
		for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
			p := clientProfile()
			p.Endpoints = p.Endpoints[:1]
			p.Endpoints[0].Connection = trojanConnection(transport)
			result, err := render.DefaultClients().Render(p, target, render.NodesOnly)
			if err != nil {
				t.Fatal(err)
			}
			imported, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "u", SnapshotID: "snapshot", Format: target.AdapterID, Data: []byte(result.Artifacts[0].Content)})
			if err != nil {
				t.Fatal(err)
			}
			nodes, inspectErr := render.InspectNodesOnly(target, render.NodesOnly, result.Artifacts, result.NameAllocations)
			if inspectErr != nil || len(nodes) != 1 {
				t.Fatalf("Trojan inspection unavailable: %v", inspectErr)
			}
			protected := strings.Join(nodes[0].ProtectedStrings(), "|")
			if !strings.Contains(protected, "trojan-fixture") || ((transport == "ws" || transport == "httpupgrade") && !strings.Contains(protected, "fixture")) {
				t.Fatal("inspection omitted secrets")
			}
			c := imported.Snapshot.Endpoints[0].Connection
			actualTransport := "tcp"
			if c.Transport != nil {
				actualTransport = c.Transport.Type
			}
			if c.Protocol != "trojan" || c.Password != "trojan-fixture" || c.TLS == nil || c.TLS.ServerName != "tls.example" || actualTransport != transport {
				t.Fatal("Trojan fields lost")
			}
		}
	}
}
func TestTrojanGenericServerAndManagedBoundary(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, {AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}} {
		ir := serverIR(target.AdapterID, target.Version)
		p := &ir.Programs[0]
		p.Listener.Connection = trojanConnection("ws")
		p.Listener.Connection.Host = "127.0.0.1"
		p.Listener.Connection.Transport.Headers = nil
		p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem"}
		p.Egress = []domain.Connection{trojanConnection("grpc")}
		artifacts, err := render.DefaultServers().Render(ir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(artifacts[0].Content, `"trojan"`) || !strings.Contains(artifacts[0].Content, `"password": "trojan-fixture"`) {
			t.Fatal("Trojan auth dropped")
		}
		p.Instance.AdapterID = render.ServerAdapterManagedXray
		p.Instance.Version = render.ManagedXrayVersion
		if _, err = render.DefaultServers().Render(ir); err == nil {
			t.Fatal("managed accounting bypass accepted")
		}
	}
}

func TestNativeTrojanConfigurationMatrix(t *testing.T) {
	for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
		for _, kind := range []string{"mihomo", "sing-box", "xray-server", "sing-box-server"} {
			t.Run(kind+"/"+transport, func(t *testing.T) {
				env := "ROUTEWEAVER_MIHOMO_BIN"
				if strings.HasPrefix(kind, "sing-box") {
					env = "ROUTEWEAVER_SINGBOX_BIN"
				}
				if kind == "xray-server" {
					env = "ROUTEWEAVER_XRAY_BIN"
				}
				binary := os.Getenv(env)
				if binary == "" {
					t.Skip("native validator not requested")
				}
				var artifacts []domain.Artifact
				if strings.HasSuffix(kind, "-server") {
					adapter, version := render.ServerAdapterXray, render.XrayVersion
					if kind == "sing-box-server" {
						adapter, version = render.ServerAdapterSingBox, render.SingBoxVersion
					}
					ir := serverIR(adapter, version)
					p := &ir.Programs[0]
					p.Listener.Connection = trojanConnection(transport)
					p.Listener.Connection.Host = "127.0.0.1"
					p.Listener.Connection.Transport.Headers = nil
					cert, key := serverCertificate(t)
					p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: cert, PrivateKeyPEM: key}
					p.Egress = []domain.Connection{trojanConnection(transport)}
					if kind == "xray-server" && transport == "grpc" {
						p.Egress[0].Transport.Authority = "grpc.example"
					}
					var err error
					artifacts, err = render.DefaultServers().Render(ir)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					p := clientProfile()
					p.Endpoints[0].Connection = trojanConnection(transport)
					version := render.MihomoVersion
					if kind == "sing-box" {
						version = render.SingBoxVersion
					}
					result, err := render.DefaultClients().Render(p, render.Target{AdapterID: kind, Version: version}, render.FullConfig)
					if err != nil {
						t.Fatal(err)
					}
					artifacts = result.Artifacts
				}
				dir := t.TempDir()
				for _, a := range artifacts {
					path := filepath.Join(dir, a.Path)
					if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(a.Content), 0600); err != nil {
						t.Fatal(err)
					}
				}
				file := filepath.Join(dir, artifacts[0].Path)
				cwd := filepath.Dir(file)
				args := []string{"-t", "-d", cwd, "-f", file}
				if strings.HasPrefix(kind, "sing-box") {
					args = []string{"check", "-c", file}
				}
				if kind == "xray-server" {
					args = []string{"run", "-test", "-format", "json", "-config", file}
				}
				cmd := exec.Command(binary, args...)
				cmd.Dir = cwd
				if kind == "xray-server" {
					cmd.Env = append(os.Environ(), "XRAY_LOCATION_CERT="+cwd, "XRAY_LOCATION_ASSET="+cwd)
				}
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("native check: %v\n%s", err, output)
				}
			})
		}
	}
}
