package integration_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
	"routeweaver/internal/importer"
	"routeweaver/internal/render"
)

func TestImportedProcessedVLESSPassesBothNativeClients(t *testing.T) {
	cores := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cores == "" {
		t.Skip("pinned native binaries not configured")
	}
	imported, err := importer.Parse(importer.Request{SourceID: "private-source", OwnerID: "alice", SnapshotID: "snapshot-one", Format: "uri-list", Data: []byte("vless://00000000-0000-4000-8000-000000000001@proxy.example:443?type=ws&security=tls&sni=www.example.com&path=%2Fproxy#UK")})
	if err != nil {
		t.Fatal(err)
	}
	collection := domain.Collection{ID: "personal", Name: "Personal", OwnerID: "alice", Sources: []domain.CollectionSource{{SourceID: "private-source", Steps: []domain.ProcessingStep{{ID: "friendly-names", Enabled: true, Kind: "rename", Template: "Personal · {name}"}}}}}
	processed, err := conversion.ProcessCollection(collection, []domain.SourceSnapshot{imported.Snapshot})
	if err != nil {
		t.Fatal(err)
	}
	ir := domain.ClientProfileIR{SchemaVersion: "1.0", ID: "daily", Name: "Daily", OwnerID: "alice", Revision: "1", Endpoints: processed.Endpoints, DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: processed.Endpoints[0].ID}, Runtime: domain.ClientRuntime{MixedPort: 10808}}
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			result, err := render.DefaultClients().Render(ir, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Artifacts) != 1 {
				t.Fatal("expected single full config")
			}
			dir := t.TempDir()
			config := filepath.Join(dir, "config.json")
			if err = os.WriteFile(config, []byte(result.Artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"check", "-c", config}
			if target.AdapterID == "mihomo" {
				args = []string{"-t", "-d", dir, "-f", config}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(cores, target.AdapterID), args...)
			command.Dir = dir
			// Never print native output: future fixtures may hold private credentials.
			if err = command.Run(); err != nil {
				t.Fatalf("generated %s config rejected: %v", target.AdapterID, err)
			}
			if result.Names[processed.Endpoints[0].ID] != "Personal · UK" {
				t.Fatal("processing/name identity lost in output")
			}
		})
	}
}
