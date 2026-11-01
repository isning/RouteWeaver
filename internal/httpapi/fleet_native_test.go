package httpapi_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// Real loopback CP→scoped desired→native supervisor→HTTP-through-SOCKS traffic.
// This intentionally does not imply browser acceptance or real VPS execution.
func TestNativeFleetConfigureStopStartAndRollback(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit pinned Xray process opt-in required")
	}
	f := newFleetFixture(t)
	f.in.Stages = nil
	var deployment httpapi.ServerDeployment
	if e := f.s.Get("server-deployments", f.in.DeploymentID, &deployment); e != nil {
		t.Fatal(e)
	}
	for i := range deployment.IR.Programs {
		program := &deployment.IR.Programs[i]
		program.Instance.Version = render.StockXrayVersion
		f.post(t, "core-instances", program.Instance, 200)
		program.Listener.Connection.Port = publishedFreePort(t)
		f.updateEndpoint(t, program.Listener)
	}
	f.saveDeployment(t, deployment)
	runtimes := map[string]*agent.Reconciler{}
	for _, program := range deployment.IR.Programs {
		instance := program.Instance.ID
		root := filepath.Join(t.TempDir(), "private-runtime")
		if e := os.MkdirAll(root, 0700); e != nil {
			t.Fatal(e)
		}
		binary := filepath.Join(root, "xray-pinned")
		content, e := os.ReadFile(filepath.Join(dir, "xray-"+render.StockXrayVersion+"-linux-amd64"))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(binary, content, 0700); e != nil {
			t.Fatal(e)
		}
		checker, e := agent.NewNativeChecker(program.Instance.AdapterID, program.Instance.Version, binary, 5*time.Second)
		if e != nil {
			t.Fatal(e)
		}
		supervisor, e := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 100 * time.Millisecond, StopTimeout: time.Second})
		if e != nil {
			t.Fatal(e)
		}
		var enrollment httpapi.Enrollment
		f.s.Get("instance-enrollments", instance, &enrollment)
		installer, e := agent.NewCoreInstaller(filepath.Join(root, "immutable-cores"), agent.CoreInstallerOptions{OpenArchive: func(_ context.Context, release controlprotocol.CoreRelease) (io.ReadCloser, error) {
			return os.Open(filepath.Join(dir, release.ID+".download"))
		}})
		if e != nil {
			t.Fatal(e)
		}
		reconciler, e := agent.Open(root, enrollment.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour, CoreInstaller: installer})
		if e != nil {
			t.Fatal(e)
		}
		runtimes[instance] = reconciler
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, e := reconciler.StopOwned(ctx); e != nil {
				t.Error(e)
			}
			reconciler.Close()
		})
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "fleet-native-roundtrip") }))
	defer origin.Close()
	traffic := func(want bool) {
		t.Helper()
		for _, p := range deployment.IR.Programs {
			proxy, _ := url.Parse(fmt.Sprintf("socks5://fixture-user:fixture-password@127.0.0.1:%d", p.Listener.Connection.Port))
			transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
			client := &http.Client{Transport: transport, Timeout: time.Second}
			response, e := client.Get(origin.URL)
			if !want {
				if e == nil {
					response.Body.Close()
					t.Fatal("traffic succeeded while operation should restrict it")
				}
				continue
			}
			if e != nil {
				t.Fatalf("native route unavailable: %v", e)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			transport.CloseIdleConnections()
			if string(body) != "fleet-native-roundtrip" {
				t.Fatal("native data path mismatch")
			}
		}
	}
	execute := func() string {
		t.Helper()
		id := f.create(t)
		f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "execute"}, 200)
		for _, instance := range f.in.TargetIDs {
			var enrollment httpapi.Enrollment
			f.s.Get("instance-enrollments", instance, &enrollment)
			desired, e := f.transports[instance].ReceiveDesired(context.Background(), enrollment.Scope, 0)
			if e != nil || desired == nil {
				t.Fatal("no desired", e)
			}
			state, e := runtimes[instance].Submit(context.Background(), *desired)
			if f.in.Action == "stop" {
				if state.Code != "policy_restricted" {
					t.Fatalf("owned stop not observed: %+v %v", state, e)
				}
			} else if f.in.Action == "install" {
				if e != nil || state.Phase != "installed" || state.Installation == nil || state.Observed != nil {
					t.Fatalf("native immutable install altered live state: %+v %v", state, e)
				}
			} else if e != nil || state.Phase != agent.ObservedConformant {
				t.Fatalf("native apply: %+v %v", state, e)
			}
			// Even locally completed work is pending at the CP until a scoped report.
			if f.job(t, id).Status == "succeeded" {
				t.Fatal("unreported local effect claimed remotely")
			}
			if e = f.transports[instance].ReportObservation(context.Background(), enrollment.Scope, state); e != nil {
				t.Fatal(e)
			}
		}
		if job := f.job(t, id); job.Status != "succeeded" {
			t.Fatalf("exact native observations not reflected: %+v", job)
		}
		return id
	}
	f.in.Action = "install"
	f.in.TargetReleaseID = "xray-26.10.31-linux-amd64"
	execute()
	traffic(false)
	f.in.Action = "configure"
	f.in.TargetReleaseID = ""
	original := execute()
	traffic(true)
	f.in.Action = "stop"
	execute()
	traffic(false)
	f.in.Action = "start"
	execute()
	traffic(true)
	// Applying a reject config changes actual forwarding, then a new rollback
	// generation restores the reviewed historic config, not an old operation.
	for i := range deployment.IR.Programs {
		deployment.IR.Programs[i].DefaultAction = domain.ActionRef{Kind: "reject"}
	}
	deployment.IR.TopologyRevision = "reject-config"
	f.saveDeployment(t, deployment)
	f.in.Action = "configure"
	execute()
	traffic(false)
	var before controlprotocol.Desired
	f.s.Get("agent-desired", f.in.TargetIDs[0], &before)
	f.in.Action = "rollback"
	f.in.SourceBatchID = original
	rolled := execute()
	traffic(true)
	job := f.job(t, rolled)
	if job.Targets[0].Attempts[0].Identity.Generation <= before.Generation {
		t.Fatal("rollback replayed an old generation")
	}
}
