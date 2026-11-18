package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func TestNativeHostAgentInstallsMultipleCores(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not requested")
	}
	_, srv := makeServer(t)
	admin := operatorClient()
	host := domain.Host{ID: "native-host-agent", Name: "Native host fixture", Address: "192.0.2.9"}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/hosts", "", host); code != 200 {
		t.Fatal(code)
	}
	code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", map[string]any{"nodeId": host.ID, "expiresAt": time.Now().Add(time.Hour)})
	if code != 201 {
		t.Fatal(code)
	}
	epoch := out["scope"].(map[string]any)["enrollmentEpoch"].(string)
	rootTransport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: out["token"].(string), Scope: agent.Scope{NodeID: host.ID, InstanceID: "host-agent", EnrollmentEpoch: epoch}, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer rootTransport.Close()
	installer, err := agent.NewCoreInstaller(filepath.Join(t.TempDir(), "catalog"), agent.CoreInstallerOptions{OpenArchive: func(ctx context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, r.ID+".download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	states := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- agent.RunHostDriver(ctx, rootTransport, agent.HostDriverOptions{NodeID: host.ID, EnrollmentEpoch: epoch, PollInterval: 100 * time.Millisecond, ShutdownTimeout: 10 * time.Second, StartInstance: func(ctx context.Context, a controlprotocol.HostAssignment) error {
			r, err := agent.Open(filepath.Join(states, a.Instance.ID), a.Scope, agent.NewRegistry(), agent.Options{MaxLease: 15 * time.Minute, CoreInstaller: installer})
			if err != nil {
				return err
			}
			defer r.Close()
			transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: a.Token, Scope: a.Scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
			if err != nil {
				return err
			}
			defer transport.Close()
			_, err = agent.RunDriver(ctx, r, transport, nil, agent.DriverOptions{Continuous: true, PollInterval: 50 * time.Millisecond, LeaseInterval: 50 * time.Millisecond})
			return err
		}})
	}()
	cores := []struct {
		instance domain.CoreInstance
		release  string
	}{{domain.CoreInstance{ID: "native-host-xray", HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}, "xray-26.10.31-linux-amd64"}, {domain.CoreInstance{ID: "native-host-sing-box", HostID: host.ID, AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion}, "sing-box-1.14.4-linux-amd64"}}
	for _, core := range cores {
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/core-instances", "", core.instance); code != 200 {
			t.Fatal("register core", code)
		}
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/admin/hosts/"+host.ID+"/cores/"+core.instance.ID+"/install", "", map[string]any{"releaseId": core.release, "expectedGeneration": "0"}); code != 202 {
			t.Fatal("queue install", code)
		}
	}
	deadline := time.NewTimer(25 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	ready := map[string]bool{}
	for len(ready) < len(cores) {
		select {
		case err := <-done:
			t.Fatal("host agent stopped before installation", err)
		case <-deadline.C:
			t.Fatal("host agent did not report both installations")
		case <-tick.C:
			for _, core := range cores {
				if ready[core.instance.ID] {
					continue
				}
				code, _, raw := req(t, admin, "GET", srv.URL+"/api/agent/instances/"+core.instance.ID+"/state", "", nil)
				var view struct {
					Phase string                `json:"phase"`
					State controlprotocol.State `json:"state"`
				}
				if code != 200 || json.Unmarshal([]byte(raw), &view) != nil {
					t.Fatal("read install result", code)
				}
				if view.Phase == "installed" {
					if view.State.Installation == nil || view.State.Installation.ReleaseID != core.release || !view.State.NativeChecked || view.State.Observed != nil {
						t.Fatal("installation incorrectly claimed activation")
					}
					ready[core.instance.ID] = true
				}
			}
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("host agent failed to quiesce")
	}
}
