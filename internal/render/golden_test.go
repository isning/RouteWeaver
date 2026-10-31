package render_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
)

func TestFrozenClientFixturesReproduceNativeCheckedArtifacts(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", target.AdapterID, "profile.json"))
			if err != nil {
				t.Fatal(err)
			}
			var p domain.ClientProfileIR
			if err = json.Unmarshal(data, &p); err != nil {
				t.Fatal(err)
			}
			result, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(filepath.Join("testdata", target.AdapterID, target.AdapterID+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if result.Artifacts[0].Content != string(want) {
				t.Fatal("frozen profile no longer reproduces its native-checked artifact; review and regenerate explicitly")
			}
		})
	}
}
