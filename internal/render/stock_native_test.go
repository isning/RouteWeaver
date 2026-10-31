package render_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// Stock server binaries and client compatibility fixtures have separate caches.
// An explicitly requested cache must contain the exact versioned release asset;
// it must never fall back to a differently versioned compatibility binary.
type nativeTarget struct {
	render.Target
	kind, env, releaseID string
}

func nativeStockServerTargets() []nativeTarget {
	return []nativeTarget{
		{render.Target{AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}, "xray-server", "ROUTEWEAVER_STOCK_CORE_BIN_DIR", "xray-" + render.StockXrayVersion + "-linux-amd64"},
		{render.Target{AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion}, "sing-box-server", "ROUTEWEAVER_STOCK_CORE_BIN_DIR", "sing-box-" + render.StockSingBoxVersion + "-linux-amd64"},
		{render.Target{AdapterID: render.ServerAdapterXray, Version: render.HistoricalStockXrayVersion}, "xray-server", "ROUTEWEAVER_XRAY_BIN", ""},
		{render.Target{AdapterID: render.ServerAdapterSingBox, Version: render.HistoricalStockSingBoxVersion}, "sing-box-server", "ROUTEWEAVER_SINGBOX_BIN", ""},
	}
}

func nativeProtocolTargets() []nativeTarget {
	return append([]nativeTarget{
		{render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, "mihomo", "ROUTEWEAVER_MIHOMO_BIN", ""},
		{render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, "sing-box", "ROUTEWEAVER_SINGBOX_BIN", ""},
	}, nativeStockServerTargets()...)
}

func (target nativeTarget) binary(t *testing.T) string {
	t.Helper()
	binary := os.Getenv(target.env)
	if binary == "" {
		t.Skip("native validator not requested: " + target.env + " is unset")
	}
	if target.releaseID != "" {
		binary = filepath.Join(binary, target.releaseID)
	}
	args := []string{"version"}
	if target.AdapterID == "mihomo" {
		args = []string{"-v"}
	}
	output, err := exec.Command(binary, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("native version check failed for %s: %v %s", target.Version, err, output)
	}
	for _, field := range strings.Fields(string(output)) {
		if strings.TrimPrefix(field, "v") == target.Version {
			return binary
		}
	}
	t.Fatalf("native version mismatch: expected %s, got %s", target.Version, output)
	return ""
}

// Exercise each supported transport with real certificate artifacts. The REALITY
// path remains covered separately by TestNativeServerFixtures.
func TestNativeVLESSStockTransportMatrix(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
			t.Run(target.AdapterID+"/"+target.Version+"/"+transport, func(t *testing.T) {
				binary := target.binary(t)
				connection := trojanConnection(transport)
				connection.Protocol = "vless"
				connection.Password = ""
				connection.UUID = "00000000-0000-4000-8000-000000000001"
				if target.AdapterID == render.ServerAdapterSingBox {
					connection.PacketEncoding = "xudp"
				}
				ir := serverIR(target.AdapterID, target.Version)
				p := &ir.Programs[0]
				if target.AdapterID == render.ServerAdapterXray && target.Version == render.StockXrayVersion {
					p.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
				}
				p.Listener.Connection = connection
				p.Listener.Connection.Host = "127.0.0.1"
				listenerTransport := *connection.Transport
				p.Listener.Connection.Transport = &listenerTransport
				p.Listener.Connection.Transport.Headers = nil
				cert, key := serverCertificate(t)
				p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: cert, PrivateKeyPEM: key}
				p.Egress = []domain.Connection{connection}
				artifacts, err := render.DefaultServers().Render(ir)
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
				cwd := filepath.Dir(file)
				args := []string{"run", "-test", "-format", "json", "-config", file}
				if target.AdapterID == render.ServerAdapterSingBox {
					args = []string{"check", "-c", file}
				}
				cmd := exec.Command(binary, args...)
				cmd.Dir = cwd
				if target.AdapterID == render.ServerAdapterXray {
					cmd.Env = append(os.Environ(), "XRAY_LOCATION_CERT="+cwd, "XRAY_LOCATION_ASSET="+cwd)
				}
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("native VLESS transport check: %v\n%s", err, output)
				}
			})
		}
	}
}
