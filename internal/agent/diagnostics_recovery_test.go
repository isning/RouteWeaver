package agent_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func diagnosticRecoveryTransport(t *testing.T, base string) *agent.HTTPTransport {
	t.Helper()
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: base, Token: "synthetic-fixture-token-only", Scope: agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(tr.Close)
	return tr
}
func TestDiagnosticCrashHelper(t *testing.T) {
	if os.Getenv("RW_DIAGNOSTIC_CRASH_HELPER") != "1" {
		return
	}
	tr := diagnosticRecoveryTransport(t, os.Getenv("RW_DIAGNOSTIC_CP"))
	worker, e := agent.OpenDiagnosticWorker(os.Getenv("RW_DIAGNOSTIC_ROOT"), agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": os.Getenv("RW_DIAGNOSTIC_TARGET")}}))
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	if e = worker.RunOnce(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
}
func TestDiagnosticCrashRecoveryNeverRepeatsUncertainTraffic(t *testing.T) {
	var calls atomic.Int64
	started := make(chan struct{})
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		w.Header().Set("Content-Length", "4096")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer fixture.Close()
	j := diagnosticFixture(t, fixture.URL, "download")
	j.TimeoutSeconds = 10
	var mu sync.Mutex
	reports := []diagnostics.Report{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/claim"):
			var claim struct {
				AttemptID string `json:"attemptId"`
			}
			json.NewDecoder(r.Body).Decode(&claim)
			j.AttemptID = claim.AttemptID
			json.NewEncoder(w).Encode(j)
		case strings.HasSuffix(r.URL.Path, "/result"):
			var report diagnostics.Report
			json.NewDecoder(r.Body).Decode(&report)
			reports = append(reports, report)
			w.WriteHeader(204)
		default:
			json.NewEncoder(w).Encode(j)
		}
	}))
	defer cp.Close()
	root := filepath.Join(t.TempDir(), "journal")
	child := exec.Command(os.Args[0], "-test.run=^TestDiagnosticCrashHelper$", "-test.timeout=20s")
	child.Env = append(os.Environ(), "RW_DIAGNOSTIC_CRASH_HELPER=1", "RW_DIAGNOSTIC_ROOT="+root, "RW_DIAGNOSTIC_CP="+cp.URL, "RW_DIAGNOSTIC_TARGET="+fixture.URL)
	if e := child.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { _ = child.Process.Kill() }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not start synthetic transfer")
	}
	if e := child.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = child.Wait()
	worker, e := agent.OpenDiagnosticWorker(root, agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": fixture.URL}}))
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	if e = worker.RunOnce(context.Background(), diagnosticRecoveryTransport(t, cp.URL)); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) != 1 || reports[0].Result.Status != "unknown" || reports[0].Result.CostKnown || reports[0].Result.BytesPerSecond != nil || calls.Load() != 1 {
		t.Fatalf("crash recovery replayed or fabricated %+v calls %d", reports, calls.Load())
	}
}
func TestDiagnosticLostReceiptRetriesPersistedResultWithoutTraffic(t *testing.T) {
	var calls atomic.Int64
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Length", "4096")
		w.Write([]byte(strings.Repeat("x", 4096)))
	}))
	defer fixture.Close()
	j := diagnosticFixture(t, fixture.URL, "download")
	var mu sync.Mutex
	reports := []diagnostics.Report{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/claim") {
			var claim struct {
				AttemptID string `json:"attemptId"`
			}
			json.NewDecoder(r.Body).Decode(&claim)
			j.AttemptID = claim.AttemptID
			json.NewEncoder(w).Encode(j)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/result") {
			var report diagnostics.Report
			json.NewDecoder(r.Body).Decode(&report)
			reports = append(reports, report)
			if len(reports) == 1 {
				w.WriteHeader(503)
			} else {
				w.WriteHeader(204)
			}
			return
		}
		json.NewEncoder(w).Encode(j)
	}))
	defer cp.Close()
	root := filepath.Join(t.TempDir(), "journal")
	scope := agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": fixture.URL}})
	tr := diagnosticRecoveryTransport(t, cp.URL)
	worker, e := agent.OpenDiagnosticWorker(root, scope, ex)
	if e != nil {
		t.Fatal(e)
	}
	if e = worker.RunOnce(context.Background(), tr); e == nil {
		t.Fatal("lost receipt hidden")
	}
	worker.Close()
	worker, e = agent.OpenDiagnosticWorker(root, scope, ex)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	if e = worker.RunOnce(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reports) != 2 || diagnostics.Digest(reports[0]) != diagnostics.Digest(reports[1]) || calls.Load() != 1 {
		t.Fatalf("result retry re-ran traffic %+v requests %d", reports, calls.Load())
	}
}
