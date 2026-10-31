package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func enrolledDiagnosticAgent(t *testing.T, s *store.Store, srv *httptest.Server, node, core string) (agent.Scope, *agent.HTTPTransport) {
	t.Helper()
	for _, v := range []struct {
		kind, id string
		value    any
	}{{"hosts", node, domain.Host{ID: node, Name: node, Address: "127.0.0.1"}}, {"core-instances", core, domain.CoreInstance{ID: core, HostID: node}}} {
		if e := s.Put(v.kind, v.id, v.value); e != nil {
			t.Fatal(e)
		}
	}
	code, enrolled, body := req(t, operatorClient(), "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": node, "instanceId": core, "expiresAt": time.Now().Add(time.Hour)})
	if code != 201 {
		t.Fatalf("enroll %d %s", code, body)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	json.Unmarshal(b, &scope)
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(tr.Close)
	return scope, tr
}
func TestDiagnosticAdminRequestRunsThroughRealAgentAndDurableResult(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "diagnostic-tenant")
	scope, tr := enrolledDiagnosticAgent(t, s, srv, "diagnostic-node", "diagnostic-core")
	base := srv.URL + "/api/admin/diagnostic-jobs"
	if c, _, _ := req(t, http.DefaultClient, "GET", base, "", nil); c != 401 {
		t.Fatalf("unauthenticated %d", c)
	}
	if c, _, _ := req(t, user.c, "GET", base, "", nil); c != 403 {
		t.Fatalf("tenant diagnostics %d", c)
	}
	var requests atomic.Int64
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Length", "4096")
		io.WriteString(w, strings.Repeat("a", 4096))
	}))
	defer fixture.Close()
	target := diagnostics.Target{ID: "diagnostic-target", Name: "Explicit synthetic target", NodeID: scope.NodeID, URL: fixture.URL, Methods: []string{"download"}}
	if c, _, _ := req(t, admin, "POST", srv.URL+"/api/admin/diagnostic-targets", "", target); c != 400 {
		t.Fatalf("API allowed loopback bypass %d", c)
	}
	// Local-only fixture registration deliberately bypasses HTTP target creation;
	// the executor separately requires exact local authorization for this target.
	if e := s.CreateDiagnosticTarget(target, "test-fixture", time.Now()); e != nil {
		t.Fatal(e)
	}
	input := diagnostics.Request{ID: "diagnostic-job", TargetID: target.ID, InstanceID: scope.InstanceID, Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2}
	code, out, body := req(t, admin, "POST", base, "", input)
	if code != 201 || out["status"] != "queued" || out["result"] != nil {
		t.Fatalf("request %d %s", code, body)
	}
	conflict := input
	conflict.MaxBytes = 8192
	if c, _, _ := req(t, admin, "POST", base, "", conflict); c != 409 {
		t.Fatalf("request replay conflict %d", c)
	}
	worker, e := agent.OpenDiagnosticWorker(filepath.Join(t.TempDir(), "diagnostics"), scope, agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{target.ID: fixture.URL}}))
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	if e = worker.RunOnce(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	code, _, body = req(t, admin, "GET", base+"/"+input.ID, "", nil)
	var job diagnostics.Job
	json.Unmarshal([]byte(body), &job)
	if code != 200 || job.Status != "succeeded" || job.Direction != "target_to_node" || job.Result == nil || job.Result.BytesReceived != 4096 || job.Result.BytesPerSecond == nil || !job.Result.CostKnown {
		t.Fatalf("measured result %d %s", code, body)
	}
	if e = worker.RunOnce(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	if requests.Load() != 1 {
		t.Fatal("completed traffic repeated")
	}
	report := diagnostics.Report{JobID: job.ID, Scope: scope, AttemptID: job.AttemptID, Result: *job.Result}
	if e = tr.ReportDiagnostic(context.Background(), report); e != nil {
		t.Fatalf("identical result retry %v", e)
	}
	report.Result.BytesReceived--
	if e = tr.ReportDiagnostic(context.Background(), report); e == nil {
		t.Fatal("conflicting result accepted")
	}
	otherScope, other := enrolledDiagnosticAgent(t, s, srv, "other-node", "other-core")
	if _, e = other.ReadDiagnostic(context.Background(), otherScope, job.ID); e == nil {
		t.Fatal("cross-enrollment diagnostic disclosed")
	}
	// Re-enrollment invalidates even an otherwise correctly signed old report.
	enrolledDiagnosticAgent(t, s, srv, scope.NodeID, scope.InstanceID)
	if e = tr.ReportDiagnostic(context.Background(), diagnostics.Report{JobID: job.ID, Scope: scope, AttemptID: job.AttemptID, Result: *job.Result}); e == nil {
		t.Fatal("revoked enrollment report accepted")
	}
}
func TestDiagnosticDriverCancellationStopsActualTransfer(t *testing.T) {
	s, srv := makeServer(t)
	scope, tr := enrolledDiagnosticAgent(t, s, srv, "cancel-node", "cancel-core")
	started := make(chan struct{})
	stopped := make(chan struct{})
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		w.Header().Set("Content-Length", "4096")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(stopped)
	}))
	defer fixture.Close()
	target := diagnostics.Target{ID: "cancel-target", Name: "Slow synthetic fixture", NodeID: scope.NodeID, URL: fixture.URL, Methods: []string{"download"}}
	if e := s.CreateDiagnosticTarget(target, "test", time.Now()); e != nil {
		t.Fatal(e)
	}
	input := diagnostics.Request{ID: "cancel-job", TargetID: target.ID, InstanceID: scope.InstanceID, Kind: "download", MaxBytes: 4096, TimeoutSeconds: 10}
	if c, _, b := req(t, operatorClient(), "POST", srv.URL+"/api/admin/diagnostic-jobs", "", input); c != 201 {
		t.Fatal(b)
	}
	root := t.TempDir()
	worker, e := agent.OpenDiagnosticWorker(filepath.Join(root, "diagnostics"), scope, agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{target.ID: fixture.URL}}))
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	reconciler, e := agent.Open(filepath.Join(root, "agent"), scope, agent.NewRegistry(agent.LocalFixture{}), agent.Options{MaxLease: time.Minute})
	if e != nil {
		t.Fatal(e)
	}
	defer reconciler.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, e := agent.RunDriver(ctx, reconciler, tr, nil, agent.DriverOptions{Diagnostics: worker, PollInterval: 10 * time.Millisecond, LeaseInterval: 10 * time.Millisecond, MaxRuntime: 5 * time.Second})
		done <- e
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("driver did not execute diagnostic")
	}
	code, out, body := req(t, operatorClient(), "POST", srv.URL+"/api/admin/diagnostic-jobs/"+input.ID+"/cancel", "", nil)
	if code != 200 || out["status"] != "cancel_requested" {
		t.Fatalf("cancel %d %s", code, body)
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not stop transfer")
	}
	deadline := time.Now().Add(time.Second)
	for {
		job, e := s.DiagnosticJob(input.ID, time.Now())
		if e != nil {
			t.Fatal(e)
		}
		if job.Status == "cancelled" {
			if job.Result.BytesPerSecond != nil {
				t.Fatal("cancelled rate fabricated")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cancellation result absent %+v", job)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if e = <-done; e != nil {
		t.Fatal(e)
	}
}
