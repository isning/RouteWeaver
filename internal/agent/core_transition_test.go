package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
)

type transitionFixture struct {
	LocalFixture
	version     string
	stops       int
	unknownStop bool
}

func (a *transitionFixture) Descriptor() Descriptor {
	d := a.LocalFixture.Descriptor()
	d.Version = a.version
	return d
}
func (a *transitionFixture) Restrict(ctx context.Context, root string) error {
	a.stops++
	if a.unknownStop {
		return ErrUnknownRuntime
	}
	return a.LocalFixture.Restrict(ctx, root)
}
func openTransitionTest(t *testing.T, old, next Adapter) *Reconciler {
	t.Helper()
	root := t.TempDir()
	os.Chmod(root, 0700)
	r, err := Open(root, testDesired(t, 1).Scope, NewRegistry(old, next), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}
func TestExplicitCoreTransitionValidatesBeforeStoppingAndFencesRollback(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	candidate := testDesired(t, 2)
	candidate.CoreVersion = "2"
	if _, err := r.Submit(ctx, candidate); err == nil || old.stops != 0 {
		t.Fatal("unreviewed transition modified old runtime")
	}
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	candidate.Artifacts[0].Content = "invalid"
	candidate.Digest, _ = ArtifactDigest(candidate.Artifacts)
	if state, err := r.Submit(ctx, candidate); err == nil || state.Phase != ValidationFailed || old.stops != 0 {
		t.Fatalf("failed candidate stopped old runtime: %+v %v", state, err)
	}
	candidate = testDesired(t, 3)
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	state, err := r.Submit(ctx, candidate)
	if err != nil || state.Phase != ObservedConformant || state.Observed == nil || state.Observed.CoreVersion != "2" || old.stops != 1 {
		t.Fatalf("explicit version transition: %+v %v stops=%d", state, err, old.stops)
	}
	if _, err = r.Submit(ctx, candidate); err != nil || old.stops != 1 {
		t.Fatal("idempotent transition repeated stop")
	}
	if _, err = r.Submit(ctx, first); !errors.Is(err, ErrStaleGeneration) {
		t.Fatal("old generation was allowed as rollback")
	}
	rollback := testDesired(t, 4)
	rollback.Action = "rollback"
	rollback.Transition = &controlprotocol.CoreTransition{From: candidate.Identity()}
	rollback.Lease.AccessAllowed = false
	state, err = r.Submit(ctx, rollback)
	if !errors.Is(err, ErrLeaseBlocked) || state.Observed != nil || state.Phase == ObservedConformant {
		t.Fatalf("rollback revived denied policy: %+v %v", state, err)
	}
}

func TestUnknownCoreTransitionStopNeverBecomesGreenOrOvertakes(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	old.unknownStop = true
	candidate := testDesired(t, 2)
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	state, err := r.Submit(ctx, candidate)
	if err == nil || state.Phase != Unknown || !state.RecoveryRequired || state.Observed == nil || state.Observed.Identity != first.Identity() {
		t.Fatalf("unconfirmed stop hid old evidence: %+v %v", state, err)
	}
	// Observation can prove that the still-running old identity is unchanged, but
	// recovery must report the attempt failed, not reissue a stop or claim success.
	state, err = r.Recover(ctx)
	if err != nil || state.Phase != ApplyFailed || state.Observed == nil || state.Observed.Identity != first.Identity() || old.stops != 1 {
		t.Fatalf("transition recovery replayed or turned green: %+v %v stops=%d", state, err, old.stops)
	}
	stale := candidate
	stale.Generation = 3
	stale.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	stale.Transition.From.Digest = strings.Repeat("0", 64)
	if _, err = r.Submit(ctx, stale); err == nil || old.stops != 1 {
		t.Fatal("stale transition review repeated stop")
	}
}

type slowValidationFixture struct {
	transitionFixture
	started chan struct{}
	release chan struct{}
}

func (a *slowValidationFixture) Validate(ctx context.Context, staged Staged) error {
	close(a.started)
	select {
	case <-a.release:
		return a.LocalFixture.Validate(ctx, staged)
	case <-ctx.Done():
		return ctx.Err()
	}
}
func TestCoreTransitionValidationCannotExtendOldLease(t *testing.T) {
	old := &transitionFixture{version: "1"}
	next := &slowValidationFixture{transitionFixture: transitionFixture{version: "2"}, started: make(chan struct{}), release: make(chan struct{})}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	first.Lease.ExpiresAt = time.Now().Add(80 * time.Millisecond)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	candidate := testDesired(t, 2)
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	done := make(chan error, 1)
	go func() { _, err := r.Submit(ctx, candidate); done <- err }()
	<-next.started
	deadline := time.Now().Add(300 * time.Millisecond)
	restricted := false
	for time.Now().Before(deadline) {
		observation, err := old.Observe(ctx, r.Root())
		if err == nil && observation.Generation == 0 {
			restricted = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(next.release)
	err := <-done
	if err != nil {
		t.Fatal(err)
	}
	if !restricted {
		t.Fatal("native validation extended the old runtime lease")
	}
}

func TestStopAfterFailedVersionTransitionTargetsActualOldRuntime(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	candidate := testDesired(t, 2)
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	candidate.Artifacts[0].Content = "invalid"
	candidate.Digest, _ = ArtifactDigest(candidate.Artifacts)
	if state, err := r.Submit(ctx, candidate); err == nil || state.Phase != ValidationFailed {
		t.Fatalf("candidate did not fail validation: %+v %v", state, err)
	}
	stop := testDesired(t, 3)
	stop.CoreVersion = "2"
	stop.Action = "stop"
	stop.Lease.AccessAllowed = false
	state, err := r.Submit(ctx, stop)
	if !errors.Is(err, ErrLeaseBlocked) || state.Observed != nil || old.stops != 1 || next.stops != 0 {
		t.Fatalf("stop selected desired rather than actual old runtime: %+v %v old=%d next=%d", state, err, old.stops, next.stops)
	}
}

func TestCoreTransitionCannotReplayEqualTimeLeaseAfterRevocation(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	denied := first
	denied.Generation = 2
	denied.Action = "stop"
	denied.Lease.AccessAllowed = false
	denied.Lease.Revision = "revoked"
	if _, err := r.Submit(ctx, denied); !errors.Is(err, ErrLeaseBlocked) {
		t.Fatal(err)
	}
	stale := first
	stale.Generation = 3
	stale.CoreVersion = "2"
	stale.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	state, err := r.Submit(ctx, stale)
	if err == nil || state.Observed != nil || state.HighestAccepted != 2 {
		t.Fatalf("pre-revocation permission was replayed by version transition: %+v %v", state, err)
	}
}

func TestCoreTransitionCannotReplayAfterBackdatedRevocation(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	ctx := context.Background()
	first := testDesired(t, 1)
	if _, err := r.Submit(ctx, first); err != nil {
		t.Fatal(err)
	}
	denied := first
	denied.Generation = 2
	denied.Action = "stop"
	denied.Lease.AccessAllowed = false
	denied.Lease.Revision = "revoked"
	denied.Lease.IssuedAt = first.Lease.IssuedAt.Add(-time.Second)
	if _, err := r.Submit(ctx, denied); !errors.Is(err, ErrLeaseBlocked) {
		t.Fatal(err)
	}
	stale := first
	stale.Generation = 3
	stale.CoreVersion = "2"
	stale.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	state, err := r.Submit(ctx, stale)
	if err == nil || state.Observed != nil || state.HighestAccepted != 2 {
		t.Fatalf("backdated denial reset authorization freshness fence: %+v %v", state, err)
	}
}

func TestFailedCorePreparationStillAllowsStoppingOldRuntime(t *testing.T) {
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return nil, errors.New("offline fixture")
	}})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.Chmod(root, 0700)
	old := &transitionFixture{version: "1"}
	now := time.Now().UTC()
	options := Options{MaxLease: 2 * time.Hour, CoreInstaller: installer, Now: func() time.Time { return now }}
	r, err := Open(root, testDesired(t, 1).Scope, NewRegistry(old), options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { r.Close() }()
	first := testDesired(t, 1)
	if _, err = r.Submit(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	release, _ := controlprotocol.FindCoreRelease("xray-26.10.29-linux-amd64")
	upgrade := testDesired(t, 2)
	upgrade.Action = "upgrade"
	upgrade.AdapterID = release.AdapterID
	upgrade.CoreVersion = release.Version
	upgrade.CoreReleaseID = release.ID
	upgrade.Transition = &controlprotocol.CoreTransition{From: first.Identity(), ReleaseID: release.ID, ExecutableSHA256: release.ExecutableSHA256}
	if state, err := r.Submit(context.Background(), upgrade); err == nil || state.Observed == nil || state.Observed.Identity != first.Identity() {
		t.Fatalf("failed preparation did not retain old runtime: %+v %v", state, err)
	}
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	r, err = Open(root, first.Scope, NewRegistry(old), options)
	if err != nil {
		t.Fatal(err)
	}
	if state, err := r.Recover(context.Background()); err != nil || state.RecoveryRequired || state.Phase == ObservedConformant || state.Observed == nil || state.Observed.Identity != first.Identity() {
		t.Fatalf("failed preparation did not recover exact old runtime: %+v %v", state, err)
	}
	now = first.Lease.ExpiresAt.Add(time.Second)
	if state, err := r.EnforcePolicy(context.Background()); !errors.Is(err, ErrLeaseBlocked) || state.Observed != nil || old.stops != 1 {
		t.Fatalf("missing target adapter prevented old lease enforcement: %+v %v", state, err)
	}
	if state, err := r.StopOwned(context.Background()); err != nil || state.Observed != nil || old.stops != 2 {
		t.Fatalf("missing target adapter prevented old cleanup: %+v %v", state, err)
	}
}

func TestMissingStagedTransitionAdapterIsNotAssumedAbsent(t *testing.T) {
	old, next := &transitionFixture{version: "1"}, &transitionFixture{version: "2"}
	r := openTransitionTest(t, old, next)
	first := testDesired(t, 1)
	if _, err := r.Submit(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	candidate := testDesired(t, 2)
	candidate.CoreVersion = "2"
	candidate.Transition = &controlprotocol.CoreTransition{From: first.Identity()}
	candidate.Artifacts[0].Content = "invalid"
	candidate.Digest, _ = ArtifactDigest(candidate.Artifacts)
	if _, err := r.Submit(context.Background(), candidate); err == nil {
		t.Fatal("invalid candidate was accepted")
	}
	root := r.Root()
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, first.Scope, NewRegistry(old), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	state, err := r.Recover(context.Background())
	if err == nil || !state.RecoveryRequired || state.Phase != Unknown || old.stops != 0 {
		t.Fatalf("unavailable staged candidate was optimistically assumed absent: %+v %v", state, err)
	}
}
