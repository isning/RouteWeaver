package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

func capacityDesired(t *testing.T, generation uint64, n int) Desired {
	t.Helper()
	d := testDesired(t, generation)
	d.AdapterID = ManagedXrayID
	d.CoreVersion = ManagedXrayVersion
	descriptor := entrypolicy.Descriptor{SchemaVersion: entrypolicy.SchemaVersion, AdapterID: ManagedXrayID, RuntimeVersion: ManagedXrayVersion, CoreVersion: "26.3.27", Bindings: make([]entrypolicy.Binding, n)}
	for i := range descriptor.Bindings {
		descriptor.Bindings[i] = entrypolicy.Binding{SubjectID: fmt.Sprintf("sub_%043d", i), AccountID: "u_" + strings.Repeat("a", 43), RouteID: "public-route_" + strings.Repeat("b", 16), EntryID: "entry001", InboundTag: "entry001", CredentialVersion: "credential_" + strings.Repeat("c", 16), PolicyRevision: "topology_" + strings.Repeat("d", 16), CycleID: "cycle_" + strings.Repeat("e", 32)}
	}
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	d.Artifacts = append(d.Artifacts, domain.Artifact{Path: "entry-policy.json", Content: string(raw)})
	d.Digest, err = ArtifactDigest(d.Artifacts)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func TestManagedTerminalCapacityRejectsBeforeExecutableProbe(t *testing.T) {
	checker, err := NewManagedXrayChecker(filepath.Join(t.TempDir(), "deliberately-missing-executable"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	err = checker.Validate(context.Background(), Staged{Desired: capacityDesired(t, 1, 1000), Directory: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "MANAGED_TERMINAL_CAPACITY_EXCEEDED") {
		t.Fatalf("capacity must reject before any executable check, got %v", err)
	}
}

type capacityFixture struct {
	LocalFixture
	activations, restrictions int
	legacy                    bool
}

func (f *capacityFixture) Descriptor() Descriptor {
	return Descriptor{ID: ManagedXrayID, Version: ManagedXrayVersion, CanActivate: true, Evidence: "local_fixture_only"}
}
func (f *capacityFixture) Validate(ctx context.Context, s Staged) error {
	if !f.legacy {
		if err := rejectManagedTerminalCapacity(s.Desired); err != nil {
			return err
		}
	}
	return f.LocalFixture.Validate(ctx, s)
}
func (f *capacityFixture) Activate(ctx context.Context, s Staged) error {
	f.activations++
	return f.LocalFixture.Activate(ctx, s)
}
func (f *capacityFixture) Restrict(ctx context.Context, root string) error {
	f.restrictions++
	return f.LocalFixture.Restrict(ctx, root)
}
func TestManagedTerminalCapacityKeepsHealthyFixtureGeneration(t *testing.T) {
	fixture := &capacityFixture{}
	r := openTest(t, t.TempDir(), fixture)
	healthy := capacityDesired(t, 1, 1)
	if _, err := r.Submit(context.Background(), healthy); err != nil {
		t.Fatal(err)
	}
	state, err := r.Submit(context.Background(), capacityDesired(t, 2, 1000))
	if err == nil || !strings.Contains(err.Error(), "MANAGED_TERMINAL_CAPACITY_EXCEEDED") || state.Phase != ValidationFailed {
		t.Fatalf("capacity did not fail validation: %s %v", state.Phase, err)
	}
	if fixture.activations != 1 || fixture.restrictions != 0 || state.Observed == nil || state.Observed.Identity != healthy.Identity() || state.LastKnownValid == nil || *state.LastKnownValid != healthy.Identity() {
		t.Fatalf("oversized replacement stopped/replaced healthy fixture: activates=%d restricts=%d", fixture.activations, fixture.restrictions)
	}
}

// Simulate a historical validator accepting the large configuration. The new
// validator must never become a prerequisite to withdrawing existing access.
func TestManagedTerminalCapacityLegacyOversizedStillStopsAndRevokes(t *testing.T) {
	for _, mode := range []string{"stop", "revoke", "owned-stop"} {
		t.Run(mode, func(t *testing.T) {
			fixture := &capacityFixture{legacy: true}
			r := openTest(t, t.TempDir(), fixture)
			if _, err := r.Submit(context.Background(), capacityDesired(t, 1, 1000)); err != nil {
				t.Fatal(err)
			}
			fixture.legacy = false
			if mode == "owned-stop" {
				if _, err := r.StopOwned(context.Background()); err != nil {
					t.Fatal("owned stop blocked by capacity", err)
				}
			} else {
				denied := capacityDesired(t, 2, 1000)
				denied.Lease.AccessAllowed = false
				denied.Lease.IssuedAt = time.Now().UTC()
				if mode == "stop" {
					denied.Action = "stop"
				}
				if _, err := r.Submit(context.Background(), denied); !errors.Is(err, ErrLeaseBlocked) {
					t.Fatal("explicit withdrawal blocked by capacity", err)
				}
			}
			if fixture.activations != 1 || fixture.restrictions != 1 {
				t.Fatalf("withdrawal revalidated or restarted old oversized config: activate=%d restrict=%d", fixture.activations, fixture.restrictions)
			}
			observed, err := fixture.Observe(context.Background(), r.Root())
			if err != nil || observed.Generation != 0 {
				t.Fatal("oversized legacy fixture remained running", err)
			}
		})
	}
}
