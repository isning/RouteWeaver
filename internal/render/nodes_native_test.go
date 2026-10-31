package render_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"routeweaver/internal/render"
)

// A nodes-only artifact is a merge fragment, not a standalone client
// configuration. Exercise its actual receiving shape without converting it back
// through RouteWeaver's full-config renderer.
func TestNativeClientNodesOnlyConsumption(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			env := "ROUTEWEAVER_MIHOMO_BIN"
			if target.AdapterID == "sing-box" {
				env = "ROUTEWEAVER_SINGBOX_BIN"
			}
			binary := os.Getenv(env)
			if binary == "" {
				t.Skip("native validator not requested: " + env)
			}
			artifact, err := render.DefaultClients().Render(clientProfile(), target, render.NodesOnly)
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			var receiving map[string]any
			if err = json.Unmarshal([]byte(artifact.Artifacts[0].Content), &receiving); err != nil {
				t.Fatal(err)
			}
			if target.AdapterID == "mihomo" {
				receiving["mode"] = "rule"
				receiving["proxy-groups"] = []any{map[string]any{"name": "Choose imported", "type": "select", "proxies": []string{artifact.Names["uk"], artifact.Names["us"]}}}
				receiving["rules"] = []string{"MATCH,Choose imported"}
			} else {
				receiving["route"] = map[string]any{"final": artifact.Names["uk"]}
			}
			body, err := json.Marshal(receiving)
			if err != nil {
				t.Fatal(err)
			}
			config := filepath.Join(dir, "config.json")
			if err = os.WriteFile(config, body, 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"-t", "-d", dir, "-f", config}
			if target.AdapterID == "sing-box" {
				args = []string{"check", "-c", config}
			}
			cmd := exec.Command(binary, args...)
			cmd.Dir = dir
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("nodes-only receiver rejected artifact: %v\n%s", err, out)
			}
			// Prove the native checker actually consumed the emitted nodes.
			// Mihomo -t alone does not load a file provider's node payload.
			key := "proxies"
			if target.AdapterID == "sing-box" {
				key = "outbounds"
			}
			receiving[key].([]any)[0].(map[string]any)["type"] = "invalid-fixture-protocol"
			invalid, err := json.Marshal(receiving)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(config, invalid, 0600); err != nil {
				t.Fatal(err)
			}
			reject := exec.Command(binary, args...)
			reject.Dir = dir
			if out, err := reject.CombinedOutput(); err == nil {
				t.Fatalf("native receiver did not inspect invalid node: %s", out)
			}

		})
	}
}
