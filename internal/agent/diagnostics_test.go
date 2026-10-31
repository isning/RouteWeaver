package agent_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func diagnosticFixture(t *testing.T, url, kind string) diagnostics.Job {
	t.Helper()
	maxBytes := int64(4096)
	if kind == "connectivity" {
		maxBytes = 0
	}
	j, e := diagnostics.NewJob(diagnostics.Request{ID: "job", TargetID: "target", InstanceID: "core", Kind: kind, MaxBytes: maxBytes, TimeoutSeconds: 2}, diagnostics.Target{ID: "target", Name: "Loopback fixture", NodeID: "node", URL: url, Methods: []string{kind}}, agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, "operator", time.Now().UTC())
	if e != nil {
		t.Fatal(e)
	}
	j.Status = "running"
	j.AttemptID = "attempt"
	return j
}
func TestBoundedDiagnosticExecutesOnlyLocallyAuthorizedFixture(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("credentials sent to diagnostic target")
		}
		if r.Method == "GET" {
			w.Header().Set("Content-Length", "4096")
			io.WriteString(w, strings.Repeat("a", 4096))
			return
		}
		if r.Method == "PUT" {
			n, _ := io.Copy(io.Discard, r.Body)
			if n != 4096 {
				t.Errorf("upload %d", n)
			}
			w.WriteHeader(204)
			return
		}
		w.WriteHeader(405)
	}))
	defer srv.Close()
	for _, kind := range []string{"download", "upload"} {
		t.Run(kind, func(t *testing.T) {
			j := diagnosticFixture(t, srv.URL, kind)
			blocked := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{}).Execute(context.Background(), j)
			if blocked.Status != "not_run" || blocked.BytesReceived != 0 {
				t.Fatalf("implicit loopback accepted %+v", blocked)
			}
			ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
			got := ex.Execute(context.Background(), j)
			if got.Status != "succeeded" || !got.CostKnown || got.BytesPerSecond == nil {
				t.Fatalf("actual diagnostic %+v", got)
			}
			if kind == "download" && got.BytesReceived != 4096 || kind == "upload" && got.BytesSent != 4096 {
				t.Fatalf("wrong payload cost %+v", got)
			}
		})
	}
}
func TestDiagnosticRejectsMetadataCredentialsPrivateAndReboundFixtureTargets(t *testing.T) {
	ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{})
	for _, raw := range []string{"http://169.254.169.254/latest/meta-data", "https://169.254.169.254/", "https://127.0.0.1/", "https://10.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://localhost/", "https://service.internal/", "https://user:secret@example.com/", "https://example.com/?token=secret", "file:///etc/passwd"} {
		t.Run(raw, func(t *testing.T) {
			got := ex.Execute(context.Background(), diagnosticFixture(t, raw, "download"))
			if got.Status != "not_run" || got.Code != "target_denied" || got.BytesReceived != 0 || got.BytesPerSecond != nil {
				t.Fatalf("unsafe request %+v", got)
			}
		})
	}
	authorized := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("wrong target reached") }))
	defer authorized.Close()
	ex = agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": authorized.URL}})
	got := ex.Execute(context.Background(), diagnosticFixture(t, authorized.URL+"/other", "download"))
	if got.Status != "not_run" {
		t.Fatalf("path authorization ignored %+v", got)
	}
}
func TestDiagnosticBoundsRedirectSizeDeadlineAndCancellation(t *testing.T) {
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	for _, scenario := range []string{"redirect", "oversize", "chunked", "short", "deadline", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "redirect":
					http.Redirect(w, r, target.URL, 302)
				case "oversize":
					w.Header().Set("Content-Length", "8192")
					w.WriteHeader(200)
				case "chunked":
					w.(http.Flusher).Flush()
					io.WriteString(w, "unknown length")
				case "short":
					w.Header().Set("Content-Length", "4096")
					io.WriteString(w, "short")
				default:
					select {
					case <-r.Context().Done():
					case <-time.After(3 * time.Second):
					}
				}
			}))
			defer srv.Close()
			j := diagnosticFixture(t, srv.URL, "download")
			j.TimeoutSeconds = 1
			ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancel" {
				time.AfterFunc(40*time.Millisecond, cancel)
			}
			started := time.Now()
			got := ex.Execute(ctx, j)
			if got.Status == "succeeded" || got.BytesPerSecond != nil || got.BytesReceived > 4096 || got.DurationMS < 0 {
				t.Fatalf("failed transfer became result %+v", got)
			}
			if scenario == "deadline" && (got.Code != "deadline_exceeded" || time.Since(started) > 2*time.Second) {
				t.Fatalf("unbounded deadline %+v", got)
			}
			if scenario == "cancel" && got.Status != "cancelled" {
				t.Fatalf("cancel failed %+v", got)
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("diagnostic followed redirect")
	}
}
func TestDiagnosticExecutorRejectsConcurrentTraffic(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
	defer srv.Close()
	ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
	j := diagnosticFixture(t, srv.URL, "download")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan diagnostics.Result, 1)
	go func() { done <- ex.Execute(ctx, j) }()
	<-started
	got := ex.Execute(context.Background(), j)
	if got.Status != "not_run" || got.Code != "busy" {
		t.Fatalf("parallel traffic allowed %+v", got)
	}
	cancel()
	<-done
}
func TestUploadEarlyAcknowledgementAndResetNeverInventReceiverConsumption(t *testing.T) {
	for _, mode := range []string{"early-success", "early-reject", "reset"} {
		t.Run(mode, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "reset" {
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				w.Header().Set("Connection", "close")
				if mode == "early-success" {
					w.WriteHeader(204)
				} else {
					w.WriteHeader(413)
				}
				w.(http.Flusher).Flush()
			}))
			defer srv.Close()
			j := diagnosticFixture(t, srv.URL, "upload")
			j.MaxBytes = diagnostics.MaxPayloadBytes
			j.EstimatedMaxBytes = j.MaxBytes + diagnostics.UploadResponseBytes
			ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
			got := ex.Execute(context.Background(), j)
			if got.Status == "succeeded" || got.BytesPerSecond != nil || got.CostKnown {
				t.Fatalf("early response fabricated completed measured upload %+v", got)
			}
		})
	}
}
func TestConnectivityUsesHeadAndNeverFabricatesSpeed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" {
			t.Errorf("method %s", r.Method)
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	j := diagnosticFixture(t, srv.URL, "connectivity")
	ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
	got := ex.Execute(context.Background(), j)
	if got.Status != "succeeded" || got.BytesReceived != 0 || got.BytesSent != 0 || got.BytesPerSecond != nil || got.DurationMS < 0 {
		t.Fatalf("connectivity fabricated speed/cost %+v", got)
	}
}
func TestDelayedClaimCannotOutliveItsControlPlaneExecutionWindow(t *testing.T) {
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.WriteHeader(204) }))
	defer srv.Close()
	j := diagnosticFixture(t, srv.URL, "connectivity")
	claimed := time.Now().Add(-20 * time.Second)
	j.ClaimedAt = &claimed
	ex := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{LoopbackTargets: map[string]string{"target": srv.URL}})
	got := ex.Execute(context.Background(), j)
	if got.Status != "not_run" || requests.Load() != 0 {
		t.Fatalf("stale claim sent traffic %+v", got)
	}
}
