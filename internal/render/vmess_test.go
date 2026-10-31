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

func vmessConnection(transport, security string) domain.Connection {
	c := trojanConnection(transport)
	c.Protocol = "vmess"
	c.Password = ""
	c.UUID = "00000000-0000-4000-8000-000000000001"
	c.VMessSecurity = security
	return c
}
func TestVMessClientRoundtrip(t *testing.T) {
	for _, security := range []string{"auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero"} {
		for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
			for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
				p := clientProfile()
				p.Endpoints = p.Endpoints[:1]
				p.Endpoints[0].Connection = vmessConnection(transport, security)
				result, err := render.DefaultClients().Render(p, target, render.NodesOnly)
				if err != nil {
					t.Fatal(err)
				}
				imported, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "u", SnapshotID: "snap", Format: target.AdapterID, Data: []byte(result.Artifacts[0].Content)})
				if err != nil {
					t.Fatal(err)
				}
				c := imported.Snapshot.Endpoints[0].Connection
				if c.Protocol != "vmess" || c.VMessSecurity != security || c.UUID != p.Endpoints[0].Connection.UUID {
					t.Fatal("VMess fields lost")
				}
				if _, err := render.InspectNodesOnly(target, render.NodesOnly, result.Artifacts, result.NameAllocations); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}

func TestNativeVMessConfigurationMatrix(t *testing.T) {
	for _, securityVariant := range []string{"auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero", "auto-no-tls"} {
		security := securityVariant
		plain := securityVariant == "auto-no-tls"
		if plain {
			security = "auto"
		}
		for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
			for _, target := range nativeProtocolTargets() {
				kind := target.kind
				t.Run(kind+"/"+target.Version+"/"+transport+"/"+securityVariant, func(t *testing.T) {
					binary := target.binary(t)
					var artifacts []domain.Artifact
					if strings.HasSuffix(kind, "-server") {
						ir := serverIR(target.AdapterID, target.Version)
						p := &ir.Programs[0]
						p.Listener.Connection = vmessConnection(transport, "auto")
						p.Listener.Connection.Host = "127.0.0.1"
						p.Listener.Connection.Transport.Headers = nil
						if plain {
							p.Listener.Connection.TLS = nil
						}
						cert, key := serverCertificate(t)
						p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: cert, PrivateKeyPEM: key}
						p.Egress = []domain.Connection{vmessConnection(transport, security)}
						if plain {
							p.TLS = nil
							p.Egress[0].TLS = nil
						}
						var err error
						artifacts, err = render.DefaultServers().Render(ir)
						if err != nil {
							t.Fatal(err)
						}
					} else {
						p := clientProfile()
						p.Endpoints[0].Connection = vmessConnection(transport, security)
						if plain {
							p.Endpoints[0].Connection.TLS = nil
						}
						result, err := render.DefaultClients().Render(p, target.Target, render.FullConfig)
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
}

func TestVMessListenerRejectsOutboundCipherAndManagedRejectsProtocol(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, {AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}} {
		ir := serverIR(target.AdapterID, target.Version)
		ir.Programs[0].Listener.Connection = vmessConnection("tcp", "aes-128-gcm")
		ir.Programs[0].Listener.Connection.Host = "127.0.0.1"
		if _, err := render.DefaultServers().Render(ir); err == nil || !strings.Contains(err.Error(), "VMESS_SECURITY_OUTBOUND_ONLY") {
			t.Fatalf("cipher silently lost: %v", err)
		}
		ir.Programs[0].Listener.Connection.VMessSecurity = "auto"
		ir.Programs[0].Instance.AdapterID = render.ServerAdapterManagedXray
		ir.Programs[0].Instance.Version = render.ManagedXrayVersion
		if _, err := render.DefaultServers().Render(ir); err == nil {
			t.Fatal("managed accepted VMess")
		}
	}
}
