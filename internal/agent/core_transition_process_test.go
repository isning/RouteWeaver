//go:build linux

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
)

// Synthetic native fixture, not an Xray release: separate immutable executables
// and versions exercise the real Linux process-ownership/transition seam.
func TestCoreTransitionOwnedHelper(t *testing.T) {
	position := -1
	for i, arg := range os.Args {
		if arg == "--" {
			position = i + 1
			break
		}
	}
	if position < 0 || position >= len(os.Args) {
		return
	}
	switch os.Args[position] {
	case "version":
		fmt.Print(strings.TrimPrefix(filepath.Base(os.Args[0]), "fixture-"))
		os.Exit(0)
	case "check":
		os.Exit(0)
	case "run":
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(2)
	}
}
func syntheticOwnedCore(t *testing.T, version string) *ProcessSupervisor {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "fixture-"+version)
	if err = os.WriteFile(binary, content, 0500); err != nil {
		t.Fatal(err)
	}
	args := func(command string) []string {
		return []string{"-test.run=^TestCoreTransitionOwnedHelper$", "--", command}
	}
	checker, err := NewCommandChecker(Descriptor{ID: "routeweaver/transition-fixture", Version: version, NativeValidation: true, Source: "local-synthetic-fixture"}, binary, time.Second, NativeCommandSpec{Environment: func(Staged) []string { return []string{"GORACE=atexit_sleep_ms=0"} }, VersionArgs: args("version"), MatchVersion: func(out, wanted string) bool { return out == wanted }, ValidateArgs: func(Staged) []string { return args("check") }, RunArgs: func(Staged) []string { return args("run") }})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 30 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return supervisor
}
func TestCoreTransitionStopsOnlyVerifiedOldExecutableAndObservesNewVersion(t *testing.T) {
	old, next := syntheticOwnedCore(t, "1"), syntheticOwnedCore(t, "2")
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	t.Cleanup(func() { r.StopOwned(context.Background()) })
	first := testDesired(t, 1)
	first.AdapterID = "routeweaver/transition-fixture"
	if state, err := r.Submit(ctx, first); err != nil || state.Observed == nil {
		t.Fatalf("synthetic old process: %+v %v", state, err)
	}
	candidate := testDesired(t, 2)
	candidate.AdapterID = first.AdapterID
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	cross := candidate
	cross.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	cross.Transition.From.InstanceID = "other-instance"
	if _, err := r.Submit(ctx, cross); err == nil {
		t.Fatal("cross-instance transition accepted")
	}
	if observation, err := old.Observe(ctx, r.Root()); err != nil || observation.Identity != first.Identity() {
		t.Fatalf("cross-instance request touched owned process: %+v %v", observation, err)
	}
	state, err := r.Submit(ctx, candidate)
	if err != nil || state.Observed == nil || state.Observed.Identity != candidate.Identity() || state.Phase != ObservedConformant {
		t.Fatalf("distinct executable transition failed: %+v %v", state, err)
	}
	if _, err = old.Observe(ctx, r.Root()); err == nil {
		t.Fatal("old executable adapter improperly recognized new process")
	}
	root := r.Root()
	r.Close()
	r, err = Open(root, first.Scope, NewRegistry(old, next), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if state, err = r.Recover(ctx); err != nil || state.Observed == nil || state.Observed.Identity != candidate.Identity() {
		t.Fatalf("migration recovery did not recognize exact new executable: %+v %v", state, err)
	}
	rollback := first
	rollback.Generation = 3
	rollback.Action = "rollback"
	rollback.OperationID = "rollback-fresh"
	rollback.Lease.Revision = "current-policy"
	rollback.Lease.IssuedAt = time.Now()
	rollback.Lease.ExpiresAt = time.Now().Add(time.Hour)
	rollback.Transition = &controlprotocol.CoreTransition{From: candidate.Identity()}
	if state, err = r.Submit(ctx, rollback); err != nil || state.Observed == nil || state.Observed.Identity != rollback.Identity() {
		t.Fatalf("explicit new-generation rollback: %+v %v", state, err)
	}
	if _, err = r.StopOwned(ctx); err != nil {
		t.Fatal(err)
	}
}

type tamperingNativeCandidate struct {
	*ProcessSupervisor
	binary string
}

func (a *tamperingNativeCandidate) Validate(ctx context.Context, st Staged) error {
	if err := a.ProcessSupervisor.Validate(ctx, st); err != nil {
		return err
	}
	if err := os.Chmod(a.binary, 0700); err != nil {
		return err
	}
	return os.WriteFile(a.binary, []byte("not the checked executable"), 0500)
}
func TestCoreTransitionRejectsChangedCheckedBinaryBeforeStoppingOld(t *testing.T) {
	old, next := syntheticOwnedCore(t, "1"), syntheticOwnedCore(t, "2")
	changed := &tamperingNativeCandidate{ProcessSupervisor: next, binary: next.checker.binary}
	r := openTransitionTest(t, old, changed)
	ctx := context.Background()
	defer r.StopOwned(ctx)
	first := testDesired(t, 1)
	first.AdapterID = "routeweaver/transition-fixture"
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	candidate := testDesired(t, 2)
	candidate.AdapterID = first.AdapterID
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	state, err := r.Submit(ctx, candidate)
	if err == nil || state.Phase != ValidationFailed || state.Observed == nil || state.Observed.Identity != first.Identity() {
		t.Fatalf("changed checked binary stopped old runtime or passed: %+v %v", state, err)
	}
	if observed, err := old.Observe(ctx, r.Root()); err != nil || observed.Identity != first.Identity() {
		t.Fatalf("old process lost before new executable validation: %+v %v", observed, err)
	}
}
