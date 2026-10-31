package render_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
)

func TestNativeMultiPrincipalVLESSFixtures(t *testing.T) {
	for _, target := range []struct{ adapter, version, env string }{{render.ServerAdapterXray, render.XrayVersion, "ROUTEWEAVER_XRAY_BIN"}, {render.ServerAdapterSingBox, render.SingBoxVersion, "ROUTEWEAVER_SINGBOX_BIN"}} {
		t.Run(target.adapter, func(t *testing.T) {
			binary := os.Getenv(target.env)
			if binary == "" {
				t.Skip("explicit native binary required: " + target.env)
			}
			p := principalProgram(target.adapter, target.version)
			artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "multi-user", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(t.TempDir(), "config.json")
			if err = os.WriteFile(file, []byte(artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"run", "-test", "-config", file}
			if target.adapter == render.ServerAdapterSingBox {
				args = []string{"check", "-c", file}
			}
			if output, err := exec.Command(binary, args...).CombinedOutput(); err != nil {
				t.Fatalf("native multi-principal rejection: %v %s", err, output)
			}
		})
	}
}
