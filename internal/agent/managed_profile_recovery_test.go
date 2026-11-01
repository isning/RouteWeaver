package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// A historical managed activation can contain settings now rejected by the
// native checker. Recovery/stop must preserve ownership without revalidating
// that old activation as if it were a new grant. This is a journal-policy fixture,
// not evidence that the historical executable was launched.
type historicalManagedProfileFixture struct{ LocalFixture }

func (historicalManagedProfileFixture) Descriptor() Descriptor {
	return Descriptor{ID: ManagedXrayID, Version: ManagedXrayVersion, CanActivate: true, Evidence: "local_fixture_only"}
}
func (historicalManagedProfileFixture) Validate(context.Context, Staged) error {
	return errors.New("certificate pinning unsupported on managed path")
}
func TestManagedHistoricalProfileJournalStillObservesAndStops(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	adapter := historicalManagedProfileFixture{}
	r := openTest(t, root, adapter)
	d := testDesired(t, 1)
	d.AdapterID, d.CoreVersion = ManagedXrayID, ManagedXrayVersion
	d.Artifacts[0].Content = `{"outbounds":[{"protocol":"freedom","streamSettings":{"security":"tls","tlsSettings":{"pinnedPeerCertSha256":"historical-pin"}}}]}`
	d.Digest, _ = ArtifactDigest(d.Artifacts)
	stage, err := stageFiles(root, d)
	if err != nil {
		t.Fatal(err)
	}
	if err = adapter.LocalFixture.Activate(ctx, Staged{Root: root, Directory: stage, Desired: d}); err != nil {
		t.Fatal(err)
	}
	if err = switchStage(root, stage); err != nil {
		t.Fatal(err)
	}
	identity := d.Identity()
	r.disk.Payload, r.disk.LastValid, r.disk.LatestPolicy = &d, &d, &d.Lease
	r.disk.PolicyIssuedHighWater = d.Lease.IssuedAt
	r.disk.RequestDigest, r.disk.Stage = requestDigest(d), stage
	r.disk.State.HighestAccepted, r.disk.State.Desired, r.disk.State.Phase = 1, &identity, ObservedConformant
	if err = r.persist(); err != nil {
		t.Fatal(err)
	}
	r.Close()
	r = openTest(t, root, adapter)
	if state, err := r.Recover(ctx); err != nil || state.Observed == nil || state.Observed.Identity != identity {
		t.Fatalf("historical managed journal lost observation: %+v %v", state, err)
	}
	next := d
	next.Generation = 2
	if _, err = r.Submit(ctx, next); err == nil || !strings.Contains(err.Error(), "certificate pinning") {
		t.Fatalf("new activation did not reject unsupported profile: %v", err)
	}
	stop := d
	stop.Generation = 3
	stop.Action = "stop"
	stop.Lease.AccessAllowed = false
	stop.Lease.IssuedAt = time.Now().UTC()
	if _, err = r.Submit(ctx, stop); !errors.Is(err, ErrLeaseBlocked) {
		t.Fatalf("historical owned stop: %v", err)
	}
	if observed, err := adapter.Observe(ctx, root); err != nil || !observed.Known || observed.Generation != 0 {
		t.Fatalf("historical managed runtime not stopped: %+v %v", observed, err)
	}
}
