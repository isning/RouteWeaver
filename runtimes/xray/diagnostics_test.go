package managedxray_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/xtls/xray-core/core"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/privateipc"
	managed "routeweaver/runtimes/xray"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func diagnosticJob(t *testing.T, url string) diagnostics.Job {
	t.Helper()
	scope := domain.InstanceScope{NodeID: "fra", InstanceID: "fra-core", EnrollmentEpoch: "epoch-1"}
	now := time.Now().UTC()
	j, e := diagnostics.NewJob(diagnostics.Request{ID: "probe-1", InstanceID: scope.InstanceID, TargetID: "fixture", Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2, PathMode: "managed_route", PublishedRouteID: "route-1"}, diagnostics.Target{ID: "fixture", Name: "Explicit local fixture", NodeID: scope.NodeID, URL: url, Methods: []string{"download"}}, scope, "admin", now)
	if e != nil {
		t.Fatal(e)
	}
	identity := domain.DeploymentIdentity{NodeID: scope.NodeID, InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, AdapterID: "routeweaver/managed-xray", CoreVersion: "26.3.27-rw1", Generation: 1, RevisionID: "revision-1", OperationID: "op-1", Digest: strings.Repeat("a", 64)}
	exit := identity
	exit.NodeID = "uk"
	exit.InstanceID = "uk-core"
	exit.RevisionID = "revision-2"
	j.ManagedPath = &diagnostics.ManagedPath{RouteID: "route-1", DeploymentID: "deployment-1", Fingerprint: strings.Repeat("b", 64), EntryEndpointID: "entry-1", ExitEndpointID: "exit-1", ConnectorID: "through-uk", Hops: []diagnostics.PathHop{{EndpointID: "entry-1", Identity: identity}, {EndpointID: "exit-1", Identity: exit}}}
	j.Status = "running"
	j.AttemptID = "attempt-1"
	j.ClaimedAt = &now
	return j
}
func managedDiagnosticFixture(t *testing.T, target string, allowLocal ...bool) (*managed.Runtime, *core.Instance, *privateipc.ControlClient, int) {
	t.Helper()
	transitPort := freePort(t)
	// This actual stock native transit is deliberately separate from the managed
	// entry. Stopping it must make the target unreachable through this connector.
	transit, e := core.StartInstance("json", config(transitPort))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { transit.Close() })
	var raw map[string]any
	entryPort := freePort(t)
	json.Unmarshal(config(entryPort), &raw)
	raw["outbounds"] = []any{map[string]any{"tag": "direct", "protocol": "freedom"}, map[string]any{"tag": "through-uk", "protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": "127.0.0.1", "port": transitPort, "users": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "encryption": "none"}}}}}}}
	raw["routing"] = map[string]any{"rules": []any{map[string]any{"type": "field", "inboundTag": []string{"public"}, "user": []string{"opaque-subject"}, "outboundTag": "through-uk"}, map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": "direct"}}}
	native, _ := json.Marshal(raw)
	d := descriptor()
	if len(allowLocal) == 0 || allowLocal[0] {
		d.DestinationPolicy.AllowCIDRs = []string{"127.0.0.1/32"}
	}
	authority := newLeaseService(0)
	authority.denied = true
	r, e := managed.NewWithOptions(native, d, authority, managed.Options{DiagnosticLoopbackTargets: map[string]string{"fixture": target}})
	if e != nil {
		t.Fatal(e)
	}
	if e = r.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close() })
	a, b := net.Pipe()
	client := privateipc.NewControlClient(privateipc.NewDuplex(a, a))
	server := privateipc.NewDuplex(b, b)
	done := make(chan struct{})
	go func() { defer close(done); privateipc.ServeControl(server, r) }()
	t.Cleanup(func() {
		client.Close()
		server.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("private control did not join")
		}
	})
	return r, transit, client, entryPort
}
func TestManagedDiagnosticTraversesNativeTransitAndNeverFallsBack(t *testing.T) {
	var requests atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Length", "4096")
		io.WriteString(w, strings.Repeat("x", 4096))
	}))
	defer target.Close()
	runtime, transit, client, entryPort := managedDiagnosticFixture(t, target.URL)
	j := diagnosticJob(t, target.URL)
	result, e := client.RunDiagnostic(context.Background(), j)
	if e != nil || result.Status != "succeeded" || result.BytesReceived != 4096 || result.BytesPerSecond == nil {
		t.Fatalf("actual transit result=%+v err=%v", result, e)
	}
	// Network users cannot create the private administrative Go context. Even
	// valid VLESS credentials stay denied by the deliberately denying authority.
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(target.URL, "http://"))
	var targetPort int
	fmt.Sscan(port, &targetPort)
	user := dialVLESS(t, entryPort, targetPort, "127.0.0.1", false, nil)
	user.SetDeadline(time.Now().Add(time.Second))
	user.Write([]byte("GET / HTTP/1.1\r\nHost: local\r\n\r\n"))
	userReply := make([]byte, 2)
	_, userErr := io.ReadFull(user, userReply)
	user.Close()
	if userErr == nil {
		t.Fatal("network user acquired administrative probe context")
	}
	if requests.Load() != 1 || total(runtime) != 0 {
		t.Fatal("not exactly one operational, non-tenant transfer")
	}
	// A lost response replay returns the same measured evidence, not more traffic.
	replay, e := client.RunDiagnostic(context.Background(), j)
	if e != nil || diagnostics.Digest(replay) != diagnostics.Digest(result) || requests.Load() != 1 {
		t.Fatal("replayed diagnostic re-executed")
	}
	bad := j
	copy := *j.ManagedPath
	copy.ConnectorID = "direct"
	bad.ManagedPath = &copy
	bad.ID = "override"
	bad.AttemptID = "override-attempt"
	if rejected, rejectErr := client.RunDiagnostic(context.Background(), bad); rejectErr != nil || rejected.Status != "not_run" || requests.Load() != 1 {
		t.Fatal("client supplied outbound override reached target")
	}
	if e = transit.Close(); e != nil {
		t.Fatal(e)
	}
	j.ID = "probe-transit-stopped"
	j.AttemptID = "attempt-2"
	now := time.Now().UTC()
	j.ClaimedAt = &now
	result, e = client.RunDiagnostic(context.Background(), j)
	if e != nil {
		t.Fatal(e)
	}
	if result.Status == "succeeded" || result.BytesPerSecond != nil || requests.Load() != 1 {
		t.Fatalf("stopped transit fell back to direct: %+v requests=%d", result, requests.Load())
	}
}
func TestManagedDiagnosticCancellationAndPrivateEOFCloseNativeTunnel(t *testing.T) {
	for _, mode := range []string{"cancel", "eof"} {
		t.Run(mode, func(t *testing.T) {
			started, ended := make(chan struct{}), make(chan struct{})
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(ended) }))
			defer target.Close()
			_, _, client, _ := managedDiagnosticFixture(t, target.URL)
			j := diagnosticJob(t, target.URL)
			j.TimeoutSeconds = 10
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				result, e := client.RunDiagnostic(ctx, j)
				if e == nil && result.Status == "succeeded" {
					e = fmt.Errorf("cancelled probe claimed success")
				}
				done <- e
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("probe never traversed transit")
			}
			if mode == "cancel" {
				cancel()
			} else {
				client.Close()
			}
			select {
			case <-ended:
			case <-time.After(3 * time.Second):
				t.Fatal("cancel/EOF left native target tunnel open")
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("probe did not join")
			}
		})
	}
}

func TestManagedDiagnosticStillEnforcesNativeDestinationPolicy(t *testing.T) {
	var requests atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Length", "4096")
		io.WriteString(w, strings.Repeat("x", 4096))
	}))
	defer target.Close()
	_, _, client, _ := managedDiagnosticFixture(t, target.URL, false)
	result, e := client.RunDiagnostic(context.Background(), diagnosticJob(t, target.URL))
	if e != nil {
		t.Fatal(e)
	}
	if result.Status == "succeeded" || requests.Load() != 0 {
		t.Fatalf("private diagnostic bypassed destination policy %+v", result)
	}
}
