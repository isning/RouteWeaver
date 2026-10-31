package render_test

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// This is a real native parser check, not deployment or network behavior proof.
// The full harness requires all binary env vars; ordinary unit tests skip it.
func TestNativeClientFixtures(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			env := "ROUTEWEAVER_MIHOMO_BIN"
			versionArgs := []string{"-v"}
			if target.AdapterID == "sing-box" {
				env = "ROUTEWEAVER_SINGBOX_BIN"
				versionArgs = []string{"version"}
			}
			binary := os.Getenv(env)
			if binary == "" {
				t.Skip("native validator not requested: " + env + " is unset")
			}
			version, err := exec.Command(binary, versionArgs...).CombinedOutput()
			if err != nil || !strings.Contains(string(version), target.Version) {
				t.Fatalf("native version mismatch: %s %v", version, err)
			}
			dir := t.TempDir()
			p := clientProfile()
			p.Endpoints[0].Name = "United Kingdom (Work), [TLS]"
			p.Groups[0].Name = "Choose (Main), [Group]"
			p.Runtime.Sniff = true
			p.Runtime.DNS = &domain.DNSIntent{Servers: []domain.DNSResolver{{ID: "dns", Type: "udp", Address: "1.1.1.1", Port: 53}}, Final: "dns"}
			p.Groups = append(p.Groups, domain.PolicyGroup{ID: "auto", Name: "Fast", Kind: "url-test", Members: []domain.ActionRef{{Kind: "group", Ref: "manual"}, {Kind: "endpoint", Ref: "us"}}, TestURL: "https://example.org/generate_204", IntervalSeconds: 300, ToleranceMS: 50})
			p.Rules = append(p.Rules, domain.PolicyRule{ID: "logic", Match: domain.MatchExpression{Op: "and", Children: []domain.MatchExpression{{Op: "domain-suffix", Value: "example.net"}, {Op: "not", Children: []domain.MatchExpression{{Op: "domain", Value: "excluded.example.net"}}}}}, Action: domain.ActionRef{Kind: "reject"}})
			format := "mihomo-yaml"
			resourcePath := "rules/work.yaml"
			body := "payload:\n  - DOMAIN-SUFFIX,example.com\n"
			if target.AdapterID == "sing-box" {
				format = "sing-box-source"
				resourcePath = "rules/work.json"
				body = `{"version":5,"rules":[{"domain_suffix":["example.com"]}]}`
				p.Runtime.TUN = &domain.TUNIntent{Enabled: true, Addresses: []string{"172.19.0.1/30"}, AutoRoute: true}
			} else {
				for _, g := range []domain.PolicyGroup{{ID: "fallback", Name: "Fallback", Kind: "fallback"}, {ID: "balance", Name: "Balance", Kind: "load-balance", Strategy: "round-robin"}} {
					g.Members = []domain.ActionRef{{Kind: "endpoint", Ref: "uk"}, {Kind: "endpoint", Ref: "us"}}
					g.TestURL = "https://example.org/generate_204"
					g.IntervalSeconds = 300
					p.Groups = append(p.Groups, g)
				}
			}
			hash := sha256.Sum256([]byte(body))
			p.Resources = []domain.RuleResource{{ID: "work", Revision: "1", Digest: "sha256:" + hex.EncodeToString(hash[:]), Format: format, FormatVersion: 5, Behavior: "classical", Location: "local", Path: resourcePath, UpdatePolicy: "pinned"}}
			p.Rules = append(p.Rules, domain.PolicyRule{ID: "resource", Match: domain.MatchExpression{Op: "resource", Value: "work"}, Action: domain.ActionRef{Kind: "group", Ref: "auto"}})
			result, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.MkdirAll(filepath.Join(dir, "rules"), 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(dir, resourcePath), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(dir, result.Artifacts[0].Path)
			if err = os.WriteFile(configPath, []byte(result.Artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"-t", "-d", dir, "-f", configPath}
			if target.AdapterID == "sing-box" {
				args = []string{"check", "-c", configPath}
			}
			cmd := exec.Command(binary, args...)
			cmd.Dir = dir
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("native check failed: %v\n%s\n%s", err, output, result.Artifacts[0].Content)
			}
			t.Logf("%s %s native configuration check passed", target.AdapterID, target.Version)
			if os.Getenv("ROUTEWEAVER_UPDATE_FIXTURES") == "1" {
				destination := filepath.Join("testdata", target.AdapterID)
				if err = os.MkdirAll(filepath.Join(destination, "rules"), 0755); err != nil {
					t.Fatal(err)
				}
				input, _ := json.MarshalIndent(p, "", "  ")
				for filename, data := range map[string][]byte{"profile.json": input, result.Artifacts[0].Path: []byte(result.Artifacts[0].Content), resourcePath: []byte(body)} {
					if err = os.WriteFile(filepath.Join(destination, filename), data, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
}

func TestNativeVLESSClientFixtures(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		for _, transport := range []string{"tcp", "ws", "grpc", "httpupgrade"} {
			t.Run(target.AdapterID+"/"+transport, func(t *testing.T) {
				env := "ROUTEWEAVER_MIHOMO_BIN"
				if target.AdapterID == "sing-box" {
					env = "ROUTEWEAVER_SINGBOX_BIN"
				}
				binary := os.Getenv(env)
				if binary == "" {
					t.Skip("native validator not requested")
				}
				p := clientProfile()
				c := domain.Connection{Host: "192.0.2.30", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", PacketEncoding: "xudp", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome"}, Transport: &domain.TransportOptions{Type: transport}}
				switch transport {
				case "tcp":
					c.Flow = "xtls-rprx-vision"
					c.TLS.Reality = &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "0123456789abcdef"}
				case "ws", "httpupgrade":
					c.Transport.Path = "/proxy"
					c.Transport.Host = "cdn.example.com"
					c.TLS.ALPN = []string{"http/1.1"}
				case "grpc":
					c.Transport.ServiceName = "proxy"
					c.TLS.ALPN = []string{"h2"}
				}
				p.Endpoints[0].Connection = c
				result, err := render.DefaultClients().Render(p, target, render.FullConfig)
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				file := filepath.Join(dir, "config.json")
				if err = os.WriteFile(file, []byte(result.Artifacts[0].Content), 0600); err != nil {
					t.Fatal(err)
				}
				args := []string{"-t", "-d", dir, "-f", file}
				if target.AdapterID == "sing-box" {
					args = []string{"check", "-c", file}
				}
				cmd := exec.Command(binary, args...)
				cmd.Dir = dir
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("native VLESS check failed: %v\n%s\n%s", err, output, result.Artifacts[0].Content)
				}
				if os.Getenv("ROUTEWEAVER_UPDATE_FIXTURES") == "1" {
					dir := filepath.Join("testdata", target.AdapterID)
					if err = os.MkdirAll(dir, 0755); err != nil {
						t.Fatal(err)
					}
					if err = os.WriteFile(filepath.Join(dir, "vless-"+transport+".json"), []byte(result.Artifacts[0].Content), 0644); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}

func TestNativeServerFixtures(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, {AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}} {
		for _, protocol := range []string{"socks", "shadowsocks", "vless"} {
			t.Run(target.AdapterID+"/"+protocol, func(t *testing.T) {
				env := "ROUTEWEAVER_XRAY_BIN"
				versionArgs := []string{"version"}
				if target.AdapterID == render.ServerAdapterSingBox {
					env = "ROUTEWEAVER_SINGBOX_BIN"
				}
				binary := os.Getenv(env)
				if binary == "" {
					t.Skip("native validator not requested: " + env)
				}
				output, err := exec.Command(binary, versionArgs...).CombinedOutput()
				if err != nil || !strings.Contains(string(output), target.Version) {
					t.Fatalf("native version mismatch: %v %s", err, output)
				}
				ir := serverIR(target.AdapterID, target.Version)
				listener := &ir.Programs[0].Listener.Connection
				switch protocol {
				case "shadowsocks":
					*listener = domain.Connection{Host: "127.0.0.1", Port: 18080, Protocol: protocol, Method: "aes-128-gcm", Password: "synthetic-only"}
				case "vless":
					*listener = domain.Connection{Host: "127.0.0.1", Port: 18443, Protocol: protocol, UUID: "00000000-0000-4000-8000-000000000001", Flow: "xtls-rprx-vision", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "0123456789abcdef"}}}
					ir.Programs[0].TLS = &domain.ServerTLSOptions{Reality: &domain.ServerRealityOptions{PrivateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", HandshakeServer: "example.com", HandshakePort: 443, ServerNames: []string{"example.com"}, ShortIDs: []string{"0123456789abcdef"}}}
					serverKeyBytes, err := base64.RawURLEncoding.DecodeString(ir.Programs[0].TLS.Reality.PrivateKey)
					if err != nil {
						t.Fatal(err)
					}
					serverKey, err := ecdh.X25519().NewPrivateKey(serverKeyBytes)
					if err != nil {
						t.Fatal(err)
					}
					listener.TLS.Reality.PublicKey = base64.RawURLEncoding.EncodeToString(serverKey.PublicKey().Bytes())
					ir.Programs[0].Egress[2] = domain.Connection{Host: "192.0.2.30", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000002", Flow: "xtls-rprx-vision", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "0123456789abcdef"}}}
				}
				ir.Programs[0].Rules = []domain.PolicyRule{{ID: "block", Match: domain.MatchExpression{Op: "domain", Value: "blocked.example"}, Action: domain.ActionRef{Kind: "reject"}}, {ID: "direct", Match: domain.MatchExpression{Op: "ip-cidr", Value: "192.0.2.0/24"}, Action: domain.ActionRef{Kind: "direct"}}}
				resourceBody := `{"version":5,"rules":[{"domain_suffix":["rules.example"]}]}`
				if target.AdapterID == render.ServerAdapterSingBox {
					hash := sha256.Sum256([]byte(resourceBody))
					ir.Programs[0].Resources = []domain.RuleResource{{ID: "server-rules", Revision: "1", Digest: "sha256:" + hex.EncodeToString(hash[:]), Format: "sing-box-source", FormatVersion: 5, Location: "local", Path: "server-rules.json", UpdatePolicy: "pinned"}}
					ir.Programs[0].Rules = append(ir.Programs[0].Rules, domain.PolicyRule{ID: "file-rule", Match: domain.MatchExpression{Op: "resource", Value: "server-rules"}, Action: domain.ActionRef{Kind: "reject"}})
				}
				artifacts, err := render.DefaultServers().Render(ir)
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				if target.AdapterID == render.ServerAdapterSingBox {
					if err = os.WriteFile(filepath.Join(dir, "server-rules.json"), []byte(resourceBody), 0600); err != nil {
						t.Fatal(err)
					}
				}
				file := filepath.Join(dir, "config.json")
				if err = os.WriteFile(file, []byte(artifacts[0].Content), 0600); err != nil {
					t.Fatal(err)
				}
				args := []string{"run", "-test", "-format", "json", "-config", file}
				if target.AdapterID == render.ServerAdapterSingBox {
					args = []string{"check", "-c", file}
				}
				cmd := exec.Command(binary, args...)
				cmd.Dir = dir
				if output, err = cmd.CombinedOutput(); err != nil {
					t.Fatalf("native server check failed: %v\n%s\n%s", err, output, artifacts[0].Content)
				}
				if os.Getenv("ROUTEWEAVER_UPDATE_FIXTURES") == "1" {
					dir := filepath.Join("testdata", "server-"+strings.TrimPrefix(target.AdapterID, "routeweaver/"))
					if err = os.MkdirAll(dir, 0755); err != nil {
						t.Fatal(err)
					}
					if target.AdapterID == render.ServerAdapterSingBox {
						if err = os.WriteFile(filepath.Join(dir, "server-rules.json"), []byte(resourceBody), 0644); err != nil {
							t.Fatal(err)
						}
					}
					if err = os.WriteFile(filepath.Join(dir, protocol+".json"), []byte(artifacts[0].Content), 0644); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}
