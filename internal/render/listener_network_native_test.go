package render_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func TestNativeServerListenerNetworkOptions(t *testing.T) {
	for _, target := range nativeStockServerTargets() {
		t.Run(target.AdapterID+"/"+target.Version, func(t *testing.T) {
			binary := target.binary(t)
			ir := serverIR(target.AdapterID, target.Version)
			on := true
			listener := &ir.Programs[0].Listener
			listener.TCP = &domain.ListenerTCPOptions{FastOpen: &on, KeepAliveIdleSeconds: 60, KeepAliveIntervalSeconds: 20}
			want := []string{`"tcpFastOpen": true`, `"tcpKeepAliveIdle": 60`, `"tcpKeepAliveInterval": 20`, `"acceptProxyProtocol": true`}
			if target.AdapterID == render.ServerAdapterSingBox {
				listener.UDP = &domain.ListenerUDPOptions{Fragment: &on, TimeoutSeconds: 300}
				want = []string{`"tcp_fast_open": true`, `"tcp_keep_alive": "60s"`, `"tcp_keep_alive_interval": "20s"`, `"udp_fragment": true`, `"udp_timeout": "300s"`}
			} else {
				listener.AcceptProxyProtocol = true
			}
			artifacts, err := render.DefaultServers().Render(ir)
			if err != nil {
				t.Fatal(err)
			}
			for _, field := range want {
				if !strings.Contains(artifacts[0].Content, field) {
					t.Fatalf("missing native option %s", field)
				}
			}
			file := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(file, []byte(artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"run", "-test", "-config", file}
			if target.AdapterID == render.ServerAdapterSingBox {
				args = []string{"check", "-c", file}
			}
			if output, err := exec.Command(binary, args...).CombinedOutput(); err != nil {
				t.Fatalf("native network options rejected: %v %s", err, output)
			}
		})
	}
}
