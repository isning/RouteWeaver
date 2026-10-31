package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"sync/atomic"
	"testing"
)

func TestLocalFixtureCLIReportsObservationNotNativeSuccess(t *testing.T) {
	var out, errs bytes.Buffer
	code := run(context.Background(), []string{"--state-dir", filepath.Join(t.TempDir(), "state"), "--max-policy-lease", "1m", "--demo"}, &out, &errs)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	var st agent.State
	if err := json.Unmarshal(out.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Phase != agent.ObservedConformant || st.NativeChecked || st.Observed.Evidence != "local_fixture_only" {
		t.Fatalf("misleading CLI evidence: %+v", st)
	}
}
func TestCLIRequiresExplicitLeaseAndNoRemoteURL(t *testing.T) {
	var out, errs bytes.Buffer
	if run(context.Background(), []string{"--demo"}, &out, &errs) != 2 {
		t.Fatal("missing storage/lease accepted")
	}
}

func TestCatalogAgentCanEnrollSessionBeforeAnyCoreIsInstalled(t *testing.T) {
	requests := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-local-token" {
			t.Error("missing explicit scoped token")
		}
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	root := t.TempDir()
	token := filepath.Join(root, "token")
	if err := os.WriteFile(token, []byte("fixture-local-token"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errs bytes.Buffer
	code := run(context.Background(), []string{"--state-dir", filepath.Join(root, "state"), "--core-store", filepath.Join(root, "cores"), "--mode", "catalog", "--max-policy-lease", "1m", "--run-for", "100ms", "--control-plane", server.URL, "--allow-loopback-http", "--token-file", token, "--node-id", "local-node", "--instance-id", "core-a", "--enrollment-epoch", "local-epoch", "--diagnostics=false"}, &out, &errs)
	if code != 0 || requests.Load() == 0 {
		t.Fatalf("first install management session failed without binary: exit=%d requests=%d %s", code, requests.Load(), errs.String())
	}
	var state agent.State
	if err := json.Unmarshal(out.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Phase == agent.ObservedConformant || state.NativeChecked {
		t.Fatal("empty management session invented installed runtime")
	}
}

func TestContinuousOutboundServiceRunsUntilCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method == http.MethodGet {
			cancel()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	root := t.TempDir()
	token := filepath.Join(root, "token")
	if err := os.WriteFile(token, []byte("fixture-local-token"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errs bytes.Buffer
	code := run(ctx, []string{"--state-dir", filepath.Join(root, "state"), "--max-policy-lease", "1m", "--service", "--control-plane", server.URL, "--allow-loopback-http", "--token-file", token, "--node-id", "local-node", "--instance-id", "core-a", "--enrollment-epoch", "local-epoch", "--diagnostics=false"}, &out, &errs)
	if code != 0 || requests.Load() == 0 {
		t.Fatalf("service failed: exit=%d requests=%d %s", code, requests.Load(), errs.String())
	}
}

func TestServiceRequiresOutboundAndExclusiveDuration(t *testing.T) {
	for _, extra := range [][]string{{"--demo", "--service"}, {"--service", "--control-plane", "https://example.invalid", "--run-for", "1s"}, {"--service", "--control-plane", "https://example.invalid", "--run-for", "0"}, {"--control-plane", "https://example.invalid", "--run-for", "0"}, {"--control-plane", "https://example.invalid", "--run-for", "2h"}} {
		var out, errs bytes.Buffer
		args := append([]string{"--state-dir", filepath.Join(t.TempDir(), "state"), "--max-policy-lease", "1m"}, extra...)
		if code := run(context.Background(), args, &out, &errs); code != 2 {
			t.Fatalf("invalid service args accepted %v: %d %s", extra, code, errs.String())
		}
	}
}
