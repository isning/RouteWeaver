//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/agent"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestServiceSignalHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "--service-test-helper" {
			os.Args = append([]string{"node-agent"}, os.Args[i+1:]...)
			main()
		}
	}
}

func TestForegroundServiceHandlesTerminationSignals(t *testing.T) {
	for _, sig := range []os.Signal{os.Interrupt, syscall.SIGTERM} {
		t.Run(sig.String(), func(t *testing.T) {
			ready := make(chan struct{})
			var once sync.Once
			var reports atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					once.Do(func() { close(ready) })
				} else {
					reports.Add(1)
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			root := t.TempDir()
			token := filepath.Join(root, "token")
			if err := os.WriteFile(token, []byte("fixture-local-token"), 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"-test.run=^TestServiceSignalHelper$", "--", "--service-test-helper", "--state-dir", filepath.Join(root, "state"), "--max-policy-lease", "1m", "--service", "--control-plane", server.URL, "--allow-loopback-http", "--token-file", token, "--node-id", "local-node", "--instance-id", "core-a", "--enrollment-epoch", "local-epoch", "--diagnostics=false"}
			cmd := exec.Command(os.Args[0], args...)
			var out, errs bytes.Buffer
			cmd.Stdout = &out
			cmd.Stderr = &errs
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-ready:
			case err := <-done:
				t.Fatalf("early exit %v: %s", err, errs.String())
			case <-time.After(5 * time.Second):
				_ = cmd.Process.Kill()
				<-done
				t.Fatal("service did not start")
			}
			if err := cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("signal shutdown failed: %v %s", err, errs.String())
				}
			case <-time.After(5 * time.Second):
				_ = cmd.Process.Kill()
				<-done
				t.Fatal("service did not stop")
			}
			var st agent.State
			if err := json.Unmarshal(out.Bytes(), &st); err != nil {
				t.Fatal(err)
			}
			if reports.Load() == 0 {
				t.Fatal("no final observation delivery")
			}
		})
	}
}
