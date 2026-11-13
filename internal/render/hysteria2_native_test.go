package render_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// These are exact-version parser checks, not evidence of QUIC connectivity.
func TestNativeHysteria2Configuration(t *testing.T) {
	connection := domain.Connection{Protocol: "hysteria2", Host: "127.0.0.1", Port: 18443, Password: "synthetic-hysteria2-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "localhost"}}
	for _, target := range []nativeTarget{
		{render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, "sing-box", "ROUTEWEAVER_SINGBOX_BIN", ""},
		{render.Target{AdapterID: render.ServerAdapterSingBox, Version: render.HistoricalStockSingBoxVersion}, "sing-box-server", "ROUTEWEAVER_SINGBOX_BIN", ""},
		{render.Target{AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion}, "sing-box-server", "ROUTEWEAVER_STOCK_CORE_BIN_DIR", "sing-box-" + render.StockSingBoxVersion + "-linux-amd64"},
	} {
		t.Run(target.AdapterID+"/"+target.Version, func(t *testing.T) {
			binary := target.binary(t)
			var artifacts []domain.Artifact
			if target.AdapterID == "sing-box" {
				profile := clientProfile()
				for i := range profile.Endpoints {
					profile.Endpoints[i].Connection = connection
				}
				result, err := render.DefaultClients().Render(profile, target.Target, render.FullConfig)
				if err != nil {
					t.Fatal(err)
				}
				artifacts = result.Artifacts
			} else {
				ir := serverIR(target.AdapterID, target.Version)
				p := &ir.Programs[0]
				p.Listener.Connection = connection
				p.Egress = nil
				p.DefaultAction = domain.ActionRef{Kind: "direct"}
				certificate, key := serverCertificate(t)
				p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
				var err error
				artifacts, err = render.DefaultServers().Render(ir)
				if err != nil {
					t.Fatal(err)
				}
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
			cmd := exec.Command(binary, "check", "-c", file)
			cmd.Dir = filepath.Dir(file)
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("native Hysteria2 parser rejected generated configuration: %v\n%s", err, output)
			}
		})
	}
}
