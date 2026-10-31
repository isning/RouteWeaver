package agent

import (
	"context"
	"errors"
	"routeweaver/internal/controlprotocol"
	"testing"
	"time"
)

// This deliberately simulated historical journal exercises recovery policy;
// it neither downloads nor launches withdrawn upstream executable bytes.
type withdrawnFixture struct{ LocalFixture }

func (withdrawnFixture) Descriptor() Descriptor {
	return Descriptor{ID: "routeweaver/xray", Version: "26.10.29", CanActivate: true, Evidence: "local_fixture_only"}
}
func TestWithdrawnReleaseJournalReopensAndStopsWithoutNewGrant(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	adapter := withdrawnFixture{}
	r := openTest(t, root, adapter)
	d := testDesired(t, 1)
	d.AdapterID = "routeweaver/xray"
	d.CoreVersion = "26.10.29"
	stage, err := stageFiles(root, d)
	if err != nil {
		t.Fatal(err)
	}
	if err = adapter.Activate(ctx, Staged{Root: root, Directory: stage, Desired: d}); err != nil {
		t.Fatal(err)
	}
	if err = switchStage(root, stage); err != nil {
		t.Fatal(err)
	}
	identity := d.Identity()
	r.disk.Payload = &d
	r.disk.LastValid = &d
	r.disk.LatestPolicy = &d.Lease
	r.disk.PolicyIssuedHighWater = d.Lease.IssuedAt
	r.disk.RequestDigest = requestDigest(d)
	r.disk.Stage = stage
	r.disk.State.HighestAccepted = 1
	r.disk.State.Desired = &identity
	r.disk.State.Phase = ObservedConformant
	if err = r.persist(); err != nil {
		t.Fatal(err)
	}
	r.Close()
	r = openTest(t, root, adapter)
	if st, err := r.Recover(ctx); err != nil || st.Observed == nil || st.Observed.Identity != identity {
		t.Fatalf("old journal cannot be observed: %+v %v", st, err)
	}
	update := controlprotocol.PolicyRefresh{Identity: identity, IntentID: "old-intent", Sequence: 1, Lease: d.Lease}
	update.Lease.IssuedAt = time.Now().UTC()
	update.Lease.ExpiresAt = update.Lease.IssuedAt.Add(time.Hour)
	if _, err = r.ApplyPolicyRefresh(ctx, update); !errors.Is(err, controlprotocol.ErrCoreReleaseRetired) {
		t.Fatalf("withdrawn refresh accepted: %v", err)
	}
	for _, action := range []string{"", "start", "configure", "rollback"} {
		next := d
		next.Generation = 2
		next.Action = action

		if _, err = r.Submit(ctx, next); !errors.Is(err, controlprotocol.ErrCoreReleaseRetired) {
			t.Fatalf("new %q accepted: %v", action, err)
		}
	}
	stop := d
	stop.Generation = 2
	stop.Action = "stop"
	stop.Lease.AccessAllowed = false
	stop.Lease.IssuedAt = time.Now().UTC()
	if _, err = r.Submit(ctx, stop); !errors.Is(err, ErrLeaseBlocked) {
		t.Fatalf("withdrawn owned stop: %v", err)
	}
	obs, err := adapter.Observe(ctx, root)
	if err != nil || !obs.Known || obs.Generation != 0 {
		t.Fatalf("old runtime was not stopped: %+v %v", obs, err)
	}
}
