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
