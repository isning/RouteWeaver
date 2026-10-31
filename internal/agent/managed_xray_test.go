package agent

import (
	"context"
	"os"
	"path/filepath"
	"routeweaver/internal/entrypolicy"
	"testing"
	"time"
)

func managedSnapshot(at time.Time, bytes uint64) entrypolicy.Snapshot {
	return entrypolicy.Snapshot{AdapterID: ManagedXrayID, RuntimeVersion: ManagedXrayVersion, CounterEpoch: "runtime-a", ObservedAt: at, LedgerMode: "admission-budget", Counters: []entrypolicy.Counter{{CounterEpoch: "runtime-a-entry", Binding: entrypolicy.Binding{SubjectID: "subject-a", AccountID: "user-a", RouteID: "route-a", EntryID: "entry-a", PolicyRevision: "policy-a", CycleID: "cycle-a", CredentialVersion: "cred-a", InboundTag: "public"}, MeasurementLayer: entrypolicy.MeasurementLayer, UploadBytes: bytes, CumulativeBytes: bytes}}}
}
func TestManagedMeterRequiresRealBaselineAndRecoversCollectionCursor(t *testing.T) {
	root := filepath.Join(t.TempDir(), "spool")
	scope := Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enroll"}
	spool, e := OpenMeterSpool(root, scope, "meter-a")
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	if e = spool.EnqueueManagedSnapshot(managedSnapshot(now, 10)); e == nil {
		t.Fatal("fabricated baseline accepted")
	}
	if e = spool.EnqueueManagedSnapshot(managedSnapshot(now, 0)); e != nil {
		t.Fatal(e)
	}
	if e = spool.EnqueueManagedSnapshot(managedSnapshot(now.Add(time.Second), 10)); e != nil {
		t.Fatal(e)
	}
	spool.Close()
	spool, e = OpenMeterSpool(root, scope, "meter-a")
	if e != nil {
		t.Fatal(e)
	}
	defer spool.Close()
	if e = spool.EnqueueManagedSnapshot(managedSnapshot(now, 0)); e != nil {
		t.Fatal(e)
	}
	if len(spool.Pending()) != 2 {
		t.Fatal("restart duplicated old baseline")
	}
	if e = spool.EnqueueManagedSnapshot(managedSnapshot(now.Add(2*time.Second), 9)); e == nil {
		t.Fatal("counter regression accepted")
	}
	pending := spool.Pending()
	if pending[0].Samples[0].CumulativeBytes != 0 || pending[1].Samples[0].CumulativeBytes != 10 {
		t.Fatal("baseline must precede live counters")
	}
}
func TestManagedCheckerUsesDistinctIdentityAndNativeSidecarCommands(t *testing.T) {
	binary := fakeCore(t, `if [ "$1" = "version" ]; then echo "RouteWeaver managed-xray 26.3.27-rw1 Xray 26.3.27"; exit 0; fi
[ "$1" = "check" ] && [ "$2" = "--config" ] && [ "$4" = "--policy" ] && [ -f "$3" ] && [ -f "$5" ] || exit 5`)
	checker, e := NewManagedXrayChecker(binary, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0600)
	os.WriteFile(filepath.Join(dir, "entry-policy.json"), []byte("{}"), 0600)
	desired := nativeDesired(t, ManagedXrayID, ManagedXrayVersion)
	if e = checker.Validate(context.Background(), Staged{Desired: desired, Directory: dir}); e != nil {
		t.Fatal(e)
	}
	stock, e := NewNativeChecker("routeweaver/xray", "26.3.27", binary, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	desired.AdapterID = "routeweaver/xray"
	desired.CoreVersion = "26.3.27"
	if stock.Validate(context.Background(), Staged{Desired: desired, Directory: dir}) == nil {
		t.Fatal("managed executable mistaken for stock Xray")
	}
}
