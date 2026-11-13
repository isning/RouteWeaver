package render_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
)

func TestNativeAnyTLSViaSOCKSConfiguration(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		if target.AdapterID != render.ServerAdapterSingBox {
			continue
		}
		t.Run(target.Version, func(t *testing.T) {
			binary := target.binary(t)
			ir := serverIR(target.AdapterID, target.Version)
			p := &ir.Programs[0]
			p.Egress = nil
			p.Connectors = []domain.ServerConnector{{ID: "a-anytls", Via: "z-socks", Connection: domain.Connection{Protocol: "anytls", Host: "127.0.0.1", Port: 18443, Password: "synthetic-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "localhost"}}}, {ID: "z-socks", Connection: domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: 18081}}}
			p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "a-anytls"}
			artifacts, err := render.DefaultServers().Render(ir)
			if err != nil {
				t.Fatal(err)
			}
			var config map[string]any
			if err := json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, raw := range config["outbounds"].([]any) {
				out := raw.(map[string]any)
				if out["tag"] == "a-anytls" {
					found = out["type"] == "anytls" && out["detour"] == "z-socks"
				}
			}
			if !found {
				t.Fatal("named AnyTLS detour was flattened or lost")
			}
			dir := t.TempDir()
			for _, a := range artifacts {
				path := filepath.Join(dir, a.Path)
				if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, []byte(a.Content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			file := filepath.Join(dir, artifacts[0].Path)
			cmd := exec.Command(binary, "check", "-c", file)
			cmd.Dir = filepath.Dir(file)
			if out, e := cmd.CombinedOutput(); e != nil {
				t.Fatalf("AnyTLS named SOCKS detour parser: %v\n%s", e, out)
			}
		})
	}
}
