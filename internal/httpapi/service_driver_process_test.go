//go:build linux

package httpapi_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCPServiceProcessHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "--cp-service-helper" {
			switch os.Args[i+1] {
			case "version":
				fmt.Print("service-fixture-v1")
				os.Exit(0)
			case "check":
				os.Exit(0)
			case "run":
				if err := os.WriteFile(os.Args[i+2], []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
					os.Exit(2)
				}
				time.Sleep(30 * time.Second)
				os.Exit(0)
			}
			os.Exit(3)
		}
	}
}

// This uses a benign owned child, not an Xray engine or route traffic. It covers
// the actual TLS-policy-independent HTTP/driver/process lifecycle together.
func TestContinuousServiceDriverRenewsWithoutRestartAndRecoversKnownDeath(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	ageContinuousLease(t, f, &d)
	// A shorter remaining interval makes the original lease expire during this
	// bounded test; the reviewed maximum duration is still the same 300 seconds.
	d.Lease.IssuedAt = time.Now().UTC().Add(-297 * time.Second)
	d.Lease.ExpiresAt = d.Lease.IssuedAt.Add(300 * time.Second)
	if err := f.s.Put("agent-desired", d.InstanceID, d); err != nil {
		t.Fatal(err)
	}
	var intent map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	intent["lease"] = d.Lease
	f.s.Put("agent-service-intents", d.InstanceID, intent)
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(t.TempDir(), "owned.pid")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := func(mode string) []string {
		return []string{"-test.run=^TestCPServiceProcessHelper$", "--", "--cp-service-helper", mode}
	}
	checker, err := agent.NewCommandChecker(agent.Descriptor{ID: d.AdapterID, Version: d.CoreVersion, NativeValidation: true, Source: "local benign CP service integration fixture"}, binary, time.Second, agent.NativeCommandSpec{VersionArgs: args("version"), MatchVersion: func(s, _ string) bool { return strings.TrimSpace(s) == "service-fixture-v1" }, ValidateArgs: func(agent.Staged) []string { return args("check") }, RunArgs: func(agent.Staged) []string { return append(args("run"), pidPath) }, Environment: func(agent.Staged) []string { return []string{"GORACE=atexit_sleep_ms=0"} }})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 10 * time.Millisecond, StopTimeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	reconciler, err := agent.Open(root, d.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: f.srv.URL, Scope: d.Scope, Token: token, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := agent.RunDriver(ctx, reconciler, transport, nil, agent.DriverOptions{Continuous: true, PollInterval: 20 * time.Millisecond, LeaseInterval: 20 * time.Millisecond})
		done <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(6 * time.Second):
			t.Error("driver shutdown timeout")
		}
		reconciler.Close()
	})
	deadline := time.Now().Add(4 * time.Second)
	var firstPID string
	for time.Now().Before(deadline) {
		fact, e := reconciler.ServiceHeartbeat(context.Background())
		raw, _ := os.ReadFile(pidPath)
		if e == nil && fact.Observed.Identity == d.Identity() && fact.PolicyIssuedAt.After(d.Lease.IssuedAt) && len(raw) > 0 {
			firstPID = string(raw)
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if firstPID == "" {
		t.Fatal("continuous driver did not apply first renewal to owned runtime")
	}
	if wait := time.Until(d.Lease.ExpiresAt.Add(150 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	raw, err := os.ReadFile(pidPath)
	if err != nil || string(raw) != firstPID {
		t.Fatal("lease renewal restarted owned process")
	}
	st := reconciler.State()
	if st.Phase != agent.ObservedConformant || st.Observed == nil || st.Observed.Identity != d.Identity() {
		t.Fatal("original lease expiry stopped a renewed runtime")
	}
	if err = supervisor.Stop(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		st = reconciler.State()
		if st.Phase == agent.ObservedConformant && st.Observed != nil && st.Observed.Generation == d.Generation+1 {
			raw, _ = os.ReadFile(pidPath)
			if len(raw) == 0 || string(raw) == firstPID {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			var next controlprotocol.Desired
			f.s.Get("agent-desired", d.InstanceID, &next)
			if next.Generation != d.Generation+1 {
				t.Fatal("recovery advanced extra generations")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("known process death did not recover under a fresh generation: %+v", st)
}
