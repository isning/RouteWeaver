package render_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
	"time"
)

func TestNativeCompletedProtocolOptions(t *testing.T) {
	for _, adapter := range []string{"mihomo", "sing-box", "sing-box-current", "sing-box-server", "sing-box-server-current", "xray-server", "xray-server-historical"} {
		for _, kind := range []string{"xhttp", "hy2-hop", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305", "ss2022-user-keys"} {
			if kind == "xhttp" && !strings.HasPrefix(adapter, "xray-server") {
				continue
			}
			if strings.Contains(adapter, "server") && (kind == "hy2-hop" || kind == "ss2022-user-keys") {
				continue
			}
			t.Run(adapter+"/"+kind, func(t *testing.T) {
				env := "ROUTEWEAVER_MIHOMO_BIN"
				if adapter == "sing-box" || adapter == "sing-box-server" {
					env = "ROUTEWEAVER_SINGBOX_BIN"
				}
				if strings.HasSuffix(adapter, "current") || strings.HasPrefix(adapter, "xray-server") {
					env = "ROUTEWEAVER_STOCK_CORE_BIN_DIR"
				}
				binary := os.Getenv(env)
				if binary == "" {
					t.Skip("native validator not requested: " + env)
				}
				version := render.SingBoxVersion
				targetAdapter := adapter
				if adapter == "mihomo" {
					version = render.MihomoVersion
				}
				if adapter == "sing-box-current" || adapter == "sing-box-server-current" {
					targetAdapter = "sing-box"
					version = render.StockSingBoxVersion
					binary = filepath.Join(binary, "sing-box-"+version+"-linux-amd64")
				}
				if strings.HasPrefix(adapter, "xray-server") {
					version = render.StockXrayVersion
					if adapter == "xray-server-historical" {
						version = render.HistoricalStockXrayVersion
					}
					binary = filepath.Join(binary, "xray-"+version+"-linux-amd64")
				}
				key := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
				if kind == "2022-blake3-aes-128-gcm" {
					key = "AAAAAAAAAAAAAAAAAAAAAA=="
				}
				c := domain.Connection{Protocol: "shadowsocks", Host: "127.0.0.1", Port: 18443, Method: kind, Password: key}
				if kind == "ss2022-user-keys" {
					c.Method = "2022-blake3-aes-256-gcm"
					c.Password += ":AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
				}
				if kind == "xhttp" {
					c = domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 18443, UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: "xhttp", Path: "/proxy", Mode: "packet-up"}}
				}
				if kind == "hy2-hop" {
					c = hysteria2Connection()
					c.Hysteria2 = &domain.Hysteria2Options{Obfs: &domain.ObfuscationOptions{Type: "salamander", Password: "synthetic-obfs"}, UpMbps: 100, DownMbps: 200, ServerPorts: []string{"443", "10000:10010"}, HopIntervalSeconds: 30}
				}
				var artifacts []domain.Artifact
				if strings.Contains(adapter, "server") {
					serverAdapter := render.ServerAdapterXray
					if strings.HasPrefix(adapter, "sing-box") {
						serverAdapter = render.ServerAdapterSingBox
					}
					ir := serverIR(serverAdapter, version)
					ir.Programs[0].Listener.Connection = c
					ir.Programs[0].Egress = nil
					ir.Programs[0].TLS = nil
					var err error
					artifacts, err = render.DefaultServers().Render(ir)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					p := clientProfile()
					p.Endpoints = p.Endpoints[:1]
					p.Endpoints[0].Connection = c
					p.Groups = nil
					p.Rules = nil
					r, err := render.DefaultClients().Render(p, render.Target{AdapterID: targetAdapter, Version: version}, render.FullConfig)
					if err != nil {
						t.Fatal(err)
					}
					artifacts = r.Artifacts
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
				path := filepath.Join(dir, artifacts[0].Path)
				args := []string{"check", "-c", path}
				if adapter == "mihomo" {
					args = []string{"-t", "-d", dir, "-f", path}
				}
				if strings.HasPrefix(adapter, "xray-server") {
					args = []string{"run", "-test", "-format", "json", "-config", path}
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, binary, args...)
				cmd.Dir = dir
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("native parser: %v\n%s", err, out)
				}
			})
		}
	}
}
