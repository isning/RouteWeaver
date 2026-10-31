package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func testDesired(t *testing.T, generation uint64) Desired {
	t.Helper()
	artifacts := []domain.Artifact{{Path: "config.json", Content: `{"outbounds":[]}`}}
	digest, err := ArtifactDigest(artifacts)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	return Desired{Scope: Scope{NodeID: "local-node", InstanceID: "core-a", EnrollmentEpoch: "local-epoch"}, AdapterID: LocalFixtureID, CoreVersion: "1", Generation: generation, RevisionID: "revision-a", OperationID: "operation-a", Digest: digest, EntryFile: "config.json", Artifacts: artifacts, Lease: PolicyLease{Revision: "policy-a", IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), AccessAllowed: true, QuotaCertain: true}}
}
func openTest(t *testing.T, dir string, adapter Adapter) *Reconciler {
	t.Helper()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := Open(dir, testDesired(t, 1).Scope, NewRegistry(adapter), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}
func TestValidateBeforeActivationAndGenerationFence(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	desired := testDesired(t, 2)
	st, err := r.Submit(context.Background(), desired)
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != ObservedConformant || st.Observed == nil || st.Observed.Generation != 2 || st.Observed.Evidence != "local_fixture_only" {
		t.Fatalf("wrong observation: %+v", st)
	}
	if _, err := r.Submit(context.Background(), testDesired(t, 1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale: %v", err)
	}
	conflict := desired
	conflict.RevisionID = "other"
	if _, err := r.Submit(context.Background(), conflict); !errors.Is(err, ErrGenerationConflict) {
		t.Fatalf("conflict: %v", err)
	}
	bad := testDesired(t, 3)
	bad.Artifacts[0].Content = "invalid-json"
	bad.Digest, _ = ArtifactDigest(bad.Artifacts)
	st, err = r.Submit(context.Background(), bad)
	if err == nil || st.Phase != ValidationFailed || st.Observed.Generation != 2 {
		t.Fatalf("validation must preserve active generation: %+v %v", st, err)
	}
	raw, err := os.ReadFile(filepath.Join(r.Root(), "current", "config.json"))
	if err != nil || string(raw) != desired.Artifacts[0].Content {
		t.Fatalf("active config changed: %s %v", raw, err)
	}
}
func TestRestartRetainsFenceAndDoesNotReplay(t *testing.T) {
	dir := t.TempDir()
	r := openTest(t, dir, LocalFixture{})
	d := testDesired(t, 9)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	r.Close()
	r = openTest(t, dir, LocalFixture{})
	if _, err := r.Submit(context.Background(), testDesired(t, 8)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatal(err)
	}
	st, err := r.Recover(context.Background())
	if err != nil || st.Observed == nil || st.Observed.Generation != 9 {
		t.Fatalf("recovery: %+v %v", st, err)
	}
}
func TestExpiredOrUncertainLeaseDoesNotActivate(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(map[bool]string{false: "expired", true: "quota_uncertain"}[uncertain], func(t *testing.T) {
			r := openTest(t, t.TempDir(), LocalFixture{})
			d := testDesired(t, 1)
			if uncertain {
				d.Lease.QuotaCertain = false
			} else {
				d.Lease.ExpiresAt = time.Now().Add(-time.Second)
			}
			st, err := r.Submit(context.Background(), d)
			if err == nil || st.Phase != Blocked || st.Observed != nil {
				t.Fatalf("unsafe lease accepted: %+v %v", st, err)
			}
		})
	}
}

type faultAdapter struct {
	LocalFixture
	mode string
}

func (a *faultAdapter) Activate(ctx context.Context, s Staged) error {
	switch a.mode {
	case "not_applied":
		return &NotAppliedError{Code: "fixture_rejected"}
	case "unknown":
		return errors.New("uncertain fixture outcome")
	case "after_apply":
		if err := a.LocalFixture.Activate(ctx, s); err != nil {
			return err
		}
		return errors.New("lost acknowledgement")
	}
	return a.LocalFixture.Activate(ctx, s)
}
func (a *faultAdapter) Observe(ctx context.Context, root string) (Observation, error) {
	if a.mode == "unknown" {
		return Observation{Quiescent: false}, nil
	}
	return a.LocalFixture.Observe(ctx, root)
}
func TestKnownFailedActivationRestoresOnlyUncommittedPointer(t *testing.T) {
	a := &faultAdapter{}
	r := openTest(t, t.TempDir(), a)
	d := testDesired(t, 1)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	a.mode = "not_applied"
	d2 := testDesired(t, 2)
	d2.Artifacts[0].Content = `{"changed":true}`
	d2.Digest, _ = ArtifactDigest(d2.Artifacts)
	st, err := r.Submit(context.Background(), d2)
	if err == nil || st.Phase != ApplyFailed || st.Observed.Generation != 1 {
		t.Fatalf("failed activation: %+v %v", st, err)
	}
	b, err := os.ReadFile(filepath.Join(r.Root(), "current", "config.json"))
	if err != nil || string(b) != d.Artifacts[0].Content {
		t.Fatalf("pointer restore failed: %s %v", b, err)
	}
	// An explicit rollback is a fresh generation, not a replay of generation 1.
	a.mode = ""
	d.Generation = 3
	st, err = r.Submit(context.Background(), d)
	if err != nil || st.Observed.Generation != 3 {
		t.Fatalf("new-generation rollback: %+v %v", st, err)
	}
}
func TestUnknownOutcomeBlocksNewerMutationUntilObserved(t *testing.T) {
	a := &faultAdapter{mode: "unknown"}
	r := openTest(t, t.TempDir(), a)
	st, err := r.Submit(context.Background(), testDesired(t, 1))
	if !errors.Is(err, ErrUnknownRuntime) || !st.RecoveryRequired {
		t.Fatalf("unknown outcome: %+v %v", st, err)
	}
	st, err = r.Submit(context.Background(), testDesired(t, 2))
	if !errors.Is(err, ErrUnknownRuntime) || st.HighestAccepted != 1 {
		t.Fatalf("overtook unquiesced mutation: %+v %v", st, err)
	}
	a.mode = ""
	st, err = r.Recover(context.Background())
	if err != nil || st.RecoveryRequired {
		t.Fatalf("quiescent recovery: %+v %v", st, err)
	}
	st, err = r.Submit(context.Background(), testDesired(t, 2))
	if err != nil || st.Observed.Generation != 2 {
		t.Fatalf("resume: %+v %v", st, err)
	}
}
func TestLostAcknowledgementRecoveredByIdentityNotReplayed(t *testing.T) {
	root := t.TempDir()
	a := &faultAdapter{mode: "after_apply"}
	r := openTest(t, root, a)
	d := testDesired(t, 7)
	if _, err := r.Submit(context.Background(), d); !errors.Is(err, ErrUnknownRuntime) {
		t.Fatal(err)
	}
	r.Close()
	r = openTest(t, root, a)
	st, err := r.Recover(context.Background())
	if err != nil || st.Phase != ObservedConformant || st.Observed.Generation != 7 {
		t.Fatalf("observed recovery: %+v %v", st, err)
	}
	if st, err = r.Submit(context.Background(), d); err != nil || st.Phase != ObservedConformant {
		t.Fatalf("retry replayed: %+v %v", st, err)
	}
}
func TestInvalidArtifactScopeAndDriftAreRejected(t *testing.T) {
	for _, p := range []string{"../outside.json", "/tmp/outside.json", "a/../../out.json", "a\\b.json", "config.json\n"} {
		t.Run(p, func(t *testing.T) {
			if _, err := ArtifactDigest([]domain.Artifact{{Path: p, Content: "{}"}}); err == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	d.EnrollmentEpoch = "another-epoch"
	if _, err := r.Submit(context.Background(), d); err == nil {
		t.Fatal("foreign enrollment accepted")
	}
	d = testDesired(t, 1)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.Root(), "current", "config.json"), []byte(`{"drift":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if st, err := r.Recover(context.Background()); !errors.Is(err, ErrUnknownRuntime) || st.Code != "active_artifact_drift" {
		t.Fatalf("drift not detected: %+v %v", st, err)
	}
}
func TestStateDoesNotExposePrivateArtifactsAndRootHasOneWriter(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	d.Artifacts[0].Content = `{"password":"SECRET_FIXTURE"}`
	d.Digest, _ = ArtifactDigest(d.Artifacts)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if other, err := Open(r.Root(), d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour}); err == nil {
		other.Close()
		t.Fatal("second writer accepted")
	}
	state := r.State()
	state.Desired.Generation = 999
	if r.State().Desired.Generation != 1 {
		t.Fatal("state escaped mutable identity")
	}
}

func TestLastValidLeaseExpiryAndClockRollbackRestrictAccess(t *testing.T) {
	root := t.TempDir()
	os.Chmod(root, 0700)
	d := testDesired(t, 1)
	now := time.Now()
	d.Lease.IssuedAt = now.Add(-time.Minute)
	d.Lease.ExpiresAt = now.Add(time.Minute)
	r, err := Open(root, d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: time.Hour, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err = r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	now = now.Add(-time.Second)
	st, err := r.EnforcePolicy(context.Background())
	if !errors.Is(err, ErrLeaseBlocked) || st.AccessDecision != "clock_rollback" || st.Observed != nil || st.Code != "policy_restricted" {
		t.Fatalf("clock rollback not restrictive: %+v %v", st, err)
	}
	now = d.Lease.ExpiresAt
	st, err = r.CheckAccess()
	if !errors.Is(err, ErrLeaseBlocked) || st.AccessDecision != "lease_expired" {
		t.Fatalf("expired lease: %+v %v", st, err)
	}
}

type serialAdapter struct {
	LocalFixture
	started chan struct{}
	release chan struct{}
}

func (a *serialAdapter) Activate(ctx context.Context, s Staged) error {
	if s.Desired.Generation == 1 {
		close(a.started)
		select {
		case <-a.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return a.LocalFixture.Activate(ctx, s)
}
func TestDelayedOldOperationCannotOvertakeCompletedNewGeneration(t *testing.T) {
	a := &serialAdapter{started: make(chan struct{}), release: make(chan struct{})}
	r := openTest(t, t.TempDir(), a)
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() { _, err := r.Submit(context.Background(), testDesired(t, 1)); first <- err }()
	<-a.started
	go func() { _, err := r.Submit(context.Background(), testDesired(t, 2)); second <- err }()
	select {
	case err := <-second:
		t.Fatalf("new operation overtook old mutation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(a.release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if r.State().Observed.Generation != 2 {
		t.Fatal("new generation not observed")
	}
	if _, err := r.Submit(context.Background(), testDesired(t, 1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatal("old generation was replayed")
	}
}

type thirdFixture struct{ LocalFixture }

func (thirdFixture) Descriptor() Descriptor {
	return Descriptor{ID: "example/third-fixture", Version: "test-v1", CanActivate: true, Evidence: "local_fixture_only"}
}
func TestRuntimeRegistryAcceptsThirdAdapterWithoutRendererSwitch(t *testing.T) {
	xray, _ := NewNativeChecker("routeweaver/xray", "26.3.27", "/fixture/xray", time.Second)
	sing, _ := NewNativeChecker("routeweaver/sing-box", "1.14.3", "/fixture/sing-box", time.Second)
	registry := NewRegistry(xray, sing, thirdFixture{})
	if len(registry.Descriptors()) != 3 {
		t.Fatal("third adapter missing")
	}
	if err := registry.Register(thirdFixture{}); err == nil {
		t.Fatal("duplicate descriptor accepted")
	}
	root := filepath.Join(t.TempDir(), "private")
	d := testDesired(t, 1)
	d.AdapterID = "example/third-fixture"
	d.CoreVersion = "test-v1"
	r, err := Open(root, d.Scope, registry, Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	st, err := r.Submit(context.Background(), d)
	if err != nil || st.Observed.AdapterID != d.AdapterID {
		t.Fatalf("third adapter failed: %+v %v", st, err)
	}
}
func TestRenewedNewGenerationCanReplaceExpiredLeaseAfterRestart(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
	options := Options{MaxLease: 2 * time.Hour, Now: func() time.Time { return now }}
	d := testDesired(t, 1)
	d.Lease.IssuedAt = now.Add(-time.Minute)
	d.Lease.ExpiresAt = now.Add(20 * time.Millisecond)
	open := func() *Reconciler {
		t.Helper()
		r, err := Open(root, d.Scope, NewRegistry(LocalFixture{}), options)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Close() })
		return r
	}
	r := open()
	if st, err := r.Submit(context.Background(), d); err != nil || st.Observed == nil || st.Observed.Generation != 1 || st.Phase != ObservedConformant || st.AccessDecision != "allowed" {
		t.Fatalf("initial authorized generation not observed: %+v %v", st, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	now = d.Lease.ExpiresAt
	r = open()
	renewed := testDesired(t, 2)
	renewed.Lease.IssuedAt = now
	renewed.Lease.ExpiresAt = now.Add(time.Hour)
	st, err := r.Submit(context.Background(), renewed)
	if err != nil || st.Observed == nil || st.Observed.Generation != 2 || st.Phase != ObservedConformant || st.AccessDecision != "allowed" {
		t.Fatalf("fresh authorized generation blocked by expired old lease: %+v %v", st, err)
	}
}

func TestAcceptedRevokedPolicyStopsOldRuntimeInsteadOfReusingLease(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	if _, err := r.Submit(context.Background(), testDesired(t, 1)); err != nil {
		t.Fatal(err)
	}
	denied := testDesired(t, 2)
	denied.Lease.AccessAllowed = false
	st, err := r.Submit(context.Background(), denied)
	if !errors.Is(err, ErrLeaseBlocked) || st.Observed != nil || st.AccessDecision != "access_denied" {
		t.Fatalf("old lease escaped revocation: %+v %v", st, err)
	}
	st, err = r.EnforcePolicy(context.Background())
	if !errors.Is(err, ErrLeaseBlocked) || st.AccessDecision != "access_denied" {
		t.Fatalf("enforcement reverted to old policy: %+v %v", st, err)
	}
}

func TestExpiredFirstActivationWithLostAcknowledgementStillRestricts(t *testing.T) {
	a := &faultAdapter{mode: "after_apply"}
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
	d := testDesired(t, 1)
	d.Lease.IssuedAt = now.Add(-time.Minute)
	d.Lease.ExpiresAt = now.Add(20 * time.Millisecond)
	r, err := Open(root, d.Scope, NewRegistry(a), Options{MaxLease: 2 * time.Hour, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	if st, err := r.Submit(context.Background(), d); !errors.Is(err, ErrUnknownRuntime) || st.LastKnownValid != nil {
		t.Fatalf("fixture expected unknown first activation: %+v %v", st, err)
	}
	obs, err := a.Observe(context.Background(), r.Root())
	if err != nil || !obs.Known || !obs.Quiescent || obs.Identity != d.Identity() {
		t.Fatalf("lost acknowledgement did not leave first generation running: %+v %v", obs, err)
	}
	now = d.Lease.ExpiresAt
	st, err := r.EnforcePolicy(context.Background())
	if !errors.Is(err, ErrLeaseBlocked) || st.AccessDecision != "lease_expired" || st.Observed != nil {
		t.Fatalf("enforce: %+v %v", st, err)
	}
	obs, err = a.Observe(context.Background(), r.Root())
	if err != nil || obs.Generation != 0 {
		t.Fatalf("unobserved first activation escaped expiry: %+v %v", obs, err)
	}
}

func TestClosedAgentCannotOverwriteNewWritersFence(t *testing.T) {
	root := t.TempDir()
	old := openTest(t, root, LocalFixture{})
	if _, err := old.Submit(context.Background(), testDesired(t, 1)); err != nil {
		t.Fatal(err)
	}
	old.Close()
	current := openTest(t, root, LocalFixture{})
	if _, err := current.Submit(context.Background(), testDesired(t, 2)); err != nil {
		t.Fatal(err)
	}
	if _, err := old.CheckAccess(); err == nil {
		t.Fatal("closed agent was allowed to persist stale state")
	}
	current.Close()
	latest := openTest(t, root, LocalFixture{})
	if latest.State().HighestAccepted != 2 {
		t.Fatal("new generation fence overwritten")
	}
}
