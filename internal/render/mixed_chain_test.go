package render_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// This exercises an explicit administrator-provided connector chain. Importing
// a tenant's private subscription into a server deployment is a separate action.
func mixedConnectorProgram(adapter, version string) domain.ServerProgram {
	p := principalProgram(adapter, version)
	p.Connectors = []domain.ServerConnector{
		{ID: "first", Connection: domain.Connection{Host: "192.0.2.10", Port: 1080, Protocol: "socks", Username: "synthetic-user", Password: "synthetic-only"}},
		{ID: "second", Via: "first", Connection: domain.Connection{Host: "192.0.2.20", Port: 8388, Protocol: "shadowsocks", Method: "aes-128-gcm", Password: "synthetic-only"}},
		{ID: "third", Via: "second", Connection: domain.Connection{Host: "192.0.2.30", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000099"}},
	}
	p.DefaultAction = domain.ActionRef{Kind: "reject"}
	p.Principals[0].Action = domain.ActionRef{Kind: "forward", Ref: "third"}
	return p
}

func TestServerMixedConnectorChainPreservesDialOrderAndPrincipalIsolation(t *testing.T) {
	for _, target := range []struct{ adapter, version string }{
		{render.ServerAdapterXray, render.StockXrayVersion},
		{render.ServerAdapterSingBox, render.StockSingBoxVersion},
		{render.ServerAdapterManagedXray, render.ManagedXrayVersion},
	} {
		for _, reordered := range []bool{false, true} {
			name := target.adapter + "/ordered"
			if reordered {
				name = target.adapter + "/reordered-declarations"
			}
			t.Run(name, func(t *testing.T) {
				p := mixedConnectorProgram(target.adapter, target.version)
				if reordered {
					p.Connectors[0], p.Connectors[2] = p.Connectors[2], p.Connectors[0]
				}
				artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "mixed-chain", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
				if err != nil {
					t.Fatal(err)
				}
				wantArtifacts := 1
				if target.adapter == render.ServerAdapterManagedXray {
					wantArtifacts = 2
				}
				if len(artifacts) != wantArtifacts || artifacts[0].Path != "ingress/config.json" {
					t.Fatalf("external connectors became deployment targets: %v", artifacts)
				}
				var config map[string]any
				if err := json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
					t.Fatal(err)
				}
				if len(config["inbounds"].([]any)) != 1 {
					t.Fatal("external connectors became listeners")
				}
				outs := map[string]map[string]any{}
				for _, value := range config["outbounds"].([]any) {
					out := value.(map[string]any)
					outs[out["tag"].(string)] = out
				}
				for _, expected := range []struct{ id, via, protocol, host string }{
					{"first", "", "socks", "192.0.2.10"},
					{"second", "first", "shadowsocks", "192.0.2.20"},
					{"third", "second", "vless", "192.0.2.30"},
				} {
					out, ok := outs[expected.id]
					if !ok {
						t.Fatalf("connector %s omitted", expected.id)
					}
					via, protocol, host := "", "", ""
					if target.adapter == render.ServerAdapterSingBox {
						via, _ = out["detour"].(string)
						protocol, _ = out["type"].(string)
						host, _ = out["server"].(string)
					} else {
						protocol, _ = out["protocol"].(string)
						if stream, ok := out["streamSettings"].(map[string]any); ok {
							if options, ok := stream["sockopt"].(map[string]any); ok {
								via, _ = options["dialerProxy"].(string)
							}
						}
						settings := out["settings"].(map[string]any)
						if expected.protocol == "vless" {
							host = settings["address"].(string)
						} else {
							host = settings["servers"].([]any)[0].(map[string]any)["address"].(string)
						}
					}
					if via != expected.via || protocol != expected.protocol || host != expected.host {
						t.Fatalf("connector %s changed: via=%q protocol=%q host=%q", expected.id, via, protocol, host)
					}
				}
				if target.adapter == render.ServerAdapterSingBox {
					rules := config["route"].(map[string]any)["rules"].([]any)
					first, second, last := rules[0].(map[string]any), rules[1].(map[string]any), rules[len(rules)-1].(map[string]any)
					if first["outbound"] != "third" || !reflect.DeepEqual(first["auth_user"], []any{"sub_alice_opaque"}) || second["action"] != "reject" || !reflect.DeepEqual(second["auth_user"], []any{"sub_bob_opaque"}) || last["action"] != "reject" {
						t.Fatal("chain selection escaped the selected principal or changed rejection")
					}
				} else {
					rules := config["routing"].(map[string]any)["rules"].([]any)
					first, second, last := rules[0].(map[string]any), rules[1].(map[string]any), rules[len(rules)-1].(map[string]any)
					if first["outboundTag"] != "third" || !reflect.DeepEqual(first["user"], []any{"sub_alice_opaque"}) || second["outboundTag"] != "rw-reject" || !reflect.DeepEqual(second["user"], []any{"sub_bob_opaque"}) || last["outboundTag"] != "rw-reject" {
						t.Fatal("chain selection escaped the selected principal or changed rejection")
					}
				}
			})
		}
	}
}

func TestServerMixedConnectorChainRejectsAmbiguousOrUnsupportedIntent(t *testing.T) {
	for _, target := range []struct{ adapter, version string }{
		{render.ServerAdapterXray, render.StockXrayVersion},
		{render.ServerAdapterSingBox, render.StockSingBoxVersion},
		{render.ServerAdapterManagedXray, render.ManagedXrayVersion},
	} {
		for _, tc := range []struct {
			name, diagnostic string
			mutate           func(*domain.ServerProgram)
		}{
			{"missing upstream", "connector reference missing", func(p *domain.ServerProgram) { p.Connectors[1].Via = "missing" }},
			{"cycle", "connector cycle", func(p *domain.ServerProgram) { p.Connectors[0].Via = "third" }},
			{"duplicate identity", "duplicated", func(p *domain.ServerProgram) { p.Connectors[1].ID = "first" }},
			{"mixed contracts", "not both", func(p *domain.ServerProgram) { p.Egress = []domain.Connection{p.Connectors[0].Connection} }},
			{"unknown protocol in middle", "unsupported", func(p *domain.ServerProgram) { p.Connectors[1].Connection.Protocol = "not-a-proxy" }},
			{"unknown principal target", "missing connector", func(p *domain.ServerProgram) { p.Principals[0].Action.Ref = "missing" }},
		} {
			t.Run(target.adapter+"/"+tc.name, func(t *testing.T) {
				p := mixedConnectorProgram(target.adapter, target.version)
				tc.mutate(&p)
				artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "mixed-chain", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
				if err == nil || !strings.Contains(strings.ToLower(err.Error()), tc.diagnostic) || len(artifacts) != 0 {
					t.Fatalf("invalid chain did not fail atomically: artifacts=%d err=%v", len(artifacts), err)
				}
			})
		}
	}
}

// Native parsing verifies the named mixed chain shape, not a remote handshake.
func TestNativeMixedConnectorChain(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		t.Run(target.AdapterID+"/"+target.Version, func(t *testing.T) {
			binary := target.binary(t)
			p := mixedConnectorProgram(target.AdapterID, target.Version)
			// This is a local parser fixture, not an encrypted public deployment.
			// Current stock Xray correctly rejects public plaintext VLESS.
			for i := range p.Connectors {
				p.Connectors[i].Connection.Host = "127.0.0.1"
			}
			p.Connectors[0], p.Connectors[2] = p.Connectors[2], p.Connectors[0]
			artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "mixed-chain", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
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
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("native mixed connector check failed: %v\n%s", err, output)
			}
			if target.AdapterID == render.ServerAdapterXray && target.Version == render.StockXrayVersion {
				for i := range p.Connectors {
					if p.Connectors[i].ID == "third" {
						p.Connectors[i].Connection.Host = "192.0.2.30"
					}
				}
				unsafe, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "mixed-chain", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(file, []byte(unsafe[0].Content), 0600); err != nil {
					t.Fatal(err)
				}
				cmd = exec.Command(binary, args...)
				cmd.Dir = dir
				output, err := cmd.CombinedOutput()
				if err == nil || !strings.Contains(string(output), "vless without TLS or other encryption is prohibited") {
					t.Fatalf("public plaintext VLESS security boundary changed: %v\n%s", err, output)
				}
			}
		})
	}
}
