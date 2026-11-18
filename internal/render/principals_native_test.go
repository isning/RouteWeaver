package render_test

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestNativeMultiPrincipalVLESSFixtures(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		t.Run(target.AdapterID+"/"+target.Version, func(t *testing.T) {
			binary := target.binary(t)
			p := principalProgram(target.AdapterID, target.Version)
			artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "multi-user", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(t.TempDir(), "config.json")
			if err = os.WriteFile(file, []byte(artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"run", "-test", "-config", file}
			if target.AdapterID == render.ServerAdapterSingBox {
				args = []string{"check", "-c", file}
			}
			if output, err := exec.Command(binary, args...).CombinedOutput(); err != nil {
				t.Fatalf("native multi-principal rejection: %v %s", err, output)
			}
		})
	}
}

func TestNativeMultiPrincipalPasswordFixtures(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		protocols := []string{"vmess", "trojan"}
		if target.AdapterID == render.ServerAdapterSingBox {
			protocols = append(protocols, "hysteria2", "anytls", "tuic", "socks", "shadowsocks")
		}
		for _, protocol := range protocols {
			t.Run(target.AdapterID+"/"+target.Version+"/"+protocol, func(t *testing.T) {
				binary := target.binary(t)
				p := principalProgram(target.AdapterID, target.Version)
				p.Listener.Authentication = "principals"
				p.Listener.Connection.Protocol = protocol
				if protocol == "shadowsocks" {
					p.Listener.Connection.Method = "2022-blake3-aes-128-gcm"
					p.Listener.Connection.Password = base64.StdEncoding.EncodeToString(make([]byte, 16))
				}
				if protocol != "vmess" && protocol != "socks" && protocol != "shadowsocks" {
					p.Listener.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "localhost"}
					certificate, key := serverCertificate(t)
					p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
				}
				uuid, password := domain.PrincipalCredentialFields(protocol)
				for i := range p.Principals {
					if !uuid {
						p.Principals[i].Credential.UUID = ""
					}
					if password {
						p.Principals[i].Credential.Password = "fixture-" + p.Principals[i].SubjectID
						if protocol == "shadowsocks" {
							key := make([]byte, 16)
							key[0] = byte(i + 1)
							p.Principals[i].Credential.Password = base64.StdEncoding.EncodeToString(key)
						}
						if protocol == "socks" {
							p.Principals[i].Credential.Username = p.Principals[i].SubjectID
						}
					}
				}
				artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "multi-password", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				for _, artifact := range artifacts {
					path := filepath.Join(dir, artifact.Path)
					if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte(artifact.Content), 0600); err != nil {
						t.Fatal(err)
					}
				}
				file := filepath.Join(dir, artifacts[0].Path)
				if p.TLS != nil && target.AdapterID == render.ServerAdapterXray {
					// This validator resolves TLS paths relative to its executable.
					content := strings.ReplaceAll(artifacts[0].Content, "tls/", filepath.Join(filepath.Dir(file), "tls")+"/")
					if err := os.WriteFile(file, []byte(content), 0600); err != nil {
						t.Fatal(err)
					}
				}
				args := []string{"run", "-test", "-config", file}
				if target.AdapterID == render.ServerAdapterSingBox {
					args = []string{"check", "-c", file}
				}
				cmd := exec.Command(binary, args...)
				cmd.Dir = filepath.Dir(file)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("native multi-principal rejection: %v %s", err, output)
				}
			})
		}
	}
}
