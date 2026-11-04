//go:build linux

package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Audit tests assert runtime observation and owned-process safety properties.
type auditDeathTransport struct {
	driverTransport
	root      string
	loss      func() error
	once      sync.Once
	dead      bool
	stale     bool
	lossErr   error
	afterLoss func(State)
}

func (tr *auditDeathTransport) ReportObservation(ctx context.Context, scope Scope, st State) error {
	wasDead := tr.dead
	if st.Phase == ObservedConformant {
		if tr.dead {
			tr.stale = true
		}
		tr.once.Do(func() {
			if tr.desired == nil || st.Observed == nil || !st.Observed.Known || !st.Observed.Quiescent || st.Observed.Identity != tr.desired.Identity() {
				tr.lossErr = fmt.Errorf("initial conformant report did not identify the expected live runtime")
				return
			}
			var err error
			if tr.loss != nil {
				err = tr.loss()
			} else {
				err = os.Remove(filepath.Join(tr.root, "fixture-observation.json"))
			}
			if err != nil {
				tr.lossErr = err
				return
			}
			tr.dead = true
		})
	}
	if tr.lossErr != nil {
		return tr.lossErr
	}
	if err := tr.driverTransport.ReportObservation(ctx, scope, st); err != nil {
		return err
	}
	if wasDead && tr.afterLoss != nil {
		tr.afterLoss(st)
	}
	return nil
}

func runAuditDriverUntilLossReported(t *testing.T, r *Reconciler, tr *auditDeathTransport) {
	t.Helper()
	// This watchdog only bounds a failed fixture. Completion requires an actual
	// in-loop report after loss, not an elapsed session that includes activation.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var postLoss *State
	tr.afterLoss = func(st State) {
		// RunDriver sends a final report with a fresh context during shutdown.
		// It cannot substitute for reobservation while the service is running.
		if ctx.Err() != nil || postLoss != nil {
			return
		}
		observed := copyState(st)
		postLoss = &observed
		cancel()
	}
	final, err := RunDriver(ctx, r, tr, nil, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, Continuous: true, OnTransportError: func(error) { cancel() }})
	// RunDriver joins its transport before returning; all callback state is read
	// only after that join. No extra test goroutine can outlive the reconciler.
	if err != nil {
		t.Fatal(err)
	}
	if tr.lossErr != nil {
		t.Fatalf("runtime loss injection failed: %v", tr.lossErr)
	}
	if !tr.dead {
		t.Fatalf("no confirmed loss after an initial conformant report: final_phase=%s final_code=%s", final.Phase, final.Code)
	}
	if postLoss == nil {
		t.Fatal("driver did not report runtime loss before cancellation")
	}
	if tr.stale || postLoss.Phase != ApplyFailed || postLoss.Code != "runtime_not_running" || postLoss.Observed != nil || postLoss.RecoveryRequired {
		t.Fatalf("post-loss report did not reflect known runtime absence: phase=%s code=%s observed=%t recovery_required=%t stale_conformance=%t", postLoss.Phase, postLoss.Code, postLoss.Observed != nil, postLoss.RecoveryRequired, tr.stale)
	}
}
func TestAuditDriverReobservesLossOfRuntime(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	tr := &auditDeathTransport{driverTransport: driverTransport{desired: &d}, root: r.Root()}
	runAuditDriverUntilLossReported(t, r, tr)
}

func TestAuditProcessHelper(t *testing.T) {
	idx := -1
	for i, a := range os.Args {
		if a == "--audit-helper" {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	mode := os.Args[idx+1]
	switch mode {
	case "version":
		fmt.Print("audit-v1")
		os.Exit(0)
	case "check":
		os.Exit(0)
	case "child":
		time.Sleep(2 * time.Second)
		os.Exit(0)
	case "steady":
		time.Sleep(5 * time.Second)
		os.Exit(0)
	case "leader":
		child := exec.Command(os.Args[0], "-test.run=^TestAuditProcessHelper$", "--", "--audit-helper", "child")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(os.Args[idx+2], []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
			os.Exit(3)
		}
		time.Sleep(100 * time.Millisecond)
		os.Exit(0)
	}
	os.Exit(4)
}
func TestAuditDriverRealOwnedProcessLoss(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := func(mode string) []string {
		return []string{"-test.run=^TestAuditProcessHelper$", "--", "--audit-helper", mode}
	}
	checker, err := NewCommandChecker(Descriptor{ID: "audit/helper", Version: "1", NativeValidation: true, Source: "local benign audit fixture"}, binary, time.Second, NativeCommandSpec{Environment: func(Staged) []string { return []string{"GORACE=atexit_sleep_ms=0"} }, VersionArgs: args("version"), MatchVersion: func(s, v string) bool { return strings.TrimSpace(s) == "audit-v1" }, ValidateArgs: func(Staged) []string { return args("check") }, RunArgs: func(Staged) []string { return args("steady") }})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 20 * time.Millisecond, StopTimeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	r := openTest(t, t.TempDir(), supervisor)
	d := testDesired(t, 1)
	d.AdapterID = "audit/helper"
	tr := &auditDeathTransport{driverTransport: driverTransport{desired: &d}, root: r.Root(), loss: func() error {
		// Respect the supervisor's mutation-lane contract without updating the
		// reconciler's cached observation. The driver must discover the loss.
		r.mu.Lock()
		defer r.mu.Unlock()
		before, err := supervisor.Observe(context.Background(), r.Root())
		if err != nil || !before.Known || !before.Quiescent || before.Identity != d.Identity() {
			return fmt.Errorf("owned runtime was not live before loss injection: %v", err)
		}
		if err := supervisor.Stop(context.Background(), r.Root()); err != nil {
			return err
		}
		after, err := supervisor.Observe(context.Background(), r.Root())
		if err != nil || !after.Known || !after.Quiescent || after.Generation != 0 {
			return fmt.Errorf("owned runtime absence was not established: %v", err)
		}
		return nil
	}}
	runAuditDriverUntilLossReported(t, r, tr)
}
func TestAuditStartupExitDoesNotHideLiveDescendant(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	args := func(mode string) []string {
		return []string{"-test.run=^TestAuditProcessHelper$", "--", "--audit-helper", mode}
	}
	checker, err := NewCommandChecker(Descriptor{ID: "audit/helper", Version: "1", NativeValidation: true, Source: "local benign audit fixture"}, binary, time.Second, NativeCommandSpec{Environment: func(Staged) []string { return []string{"GORACE=atexit_sleep_ms=0"} }, VersionArgs: args("version"), MatchVersion: func(s, v string) bool { return strings.TrimSpace(s) == "audit-v1" }, ValidateArgs: func(Staged) []string { return args("check") }, RunArgs: func(Staged) []string { return append(args("leader"), pidFile) }})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 300 * time.Millisecond, StopTimeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	r := openTest(t, t.TempDir(), supervisor)
	d := testDesired(t, 1)
	d.AdapterID = "audit/helper"
	_, err = r.Submit(context.Background(), d)
	if err == nil {
		t.Fatal("leader should exit during startup")
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	// This fixture self-terminates. Do not signal any PID or process group.
	defer time.Sleep(2100 * time.Millisecond)
	if err = syscall.Kill(pid, 0); err != nil {
		t.Fatalf("fixture child not live: %v", err)
	}
	obs, err := supervisor.Observe(context.Background(), r.Root())
	if err == nil && obs.Known && obs.Quiescent && obs.Generation == 0 {
		t.Fatal("live startup descendant exists but supervisor reports known quiescent absence")
	}
}

func TestStartupCancellationDoesNotHideLiveDescendant(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	args := func(mode string) []string {
		return []string{"-test.run=^TestAuditProcessHelper$", "--", "--audit-helper", mode}
	}
	checker, err := NewCommandChecker(Descriptor{ID: "audit/helper", Version: "1", NativeValidation: true, Source: "local benign audit fixture"}, binary, time.Second, NativeCommandSpec{Environment: func(Staged) []string { return []string{"GORACE=atexit_sleep_ms=0"} }, VersionArgs: args("version"), MatchVersion: func(s, v string) bool { return strings.TrimSpace(s) == "audit-v1" }, ValidateArgs: func(Staged) []string { return args("check") }, RunArgs: func(Staged) []string { return append(args("leader"), pidFile) }})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 300 * time.Millisecond, StopTimeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	r := openTest(t, t.TempDir(), supervisor)
	d := testDesired(t, 1)
	d.AdapterID = "audit/helper"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(pidFile); err == nil {
				cancel()
				return
			}
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	_, err = r.Submit(ctx, d)
	if err == nil {
		t.Fatal("leader should exit during startup")
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	// This fixture self-terminates. Do not signal any PID or process group.
	defer time.Sleep(2100 * time.Millisecond)
	if err = syscall.Kill(pid, 0); err != nil {
		t.Fatalf("fixture child not live: %v", err)
	}
	obs, err := supervisor.Observe(context.Background(), r.Root())
	if err == nil && obs.Known && obs.Quiescent && obs.Generation == 0 {
		t.Fatal("live startup descendant exists but supervisor reports known quiescent absence")
	}
}
