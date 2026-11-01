package store_test

import (
	"bytes"
	"context"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Segmented backup/store evidence, not verification of a browser-produced file.
// Preserve a real issued budget, then observe decisions and exactly-once usage
// through public admission APIs after encrypted streaming restoration.
func TestBackupSetRestorePreservesOutstandingAdmissionObligation(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "backup-presence")
	first, err := s.AcquireAdmission(scope, in, now)
	if err != nil || !first.Allowed || first.ByteBudget == nil || *first.ByteBudget != 100 {
		t.Fatalf("initial budget: %+v %v", first, err)
	}
	if err = s.ReleaseAdmission(scope, first.LeaseID, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	setPath := filepath.Join(t.TempDir(), "set")
	limits := backup.SetLimits{TotalBytes: 8 << 20, TotalRows: 1000, PartBytes: 64 << 10, PartRows: 2, RecordBytes: 32 << 10, Parts: 256, Duration: time.Minute, DiskBytes: 256 << 20}
	const password = "synthetic-offline-set-passphrase"
	if err = backup.CreateSet(context.Background(), s, password, setPath, limits); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "fresh.db")
	key := bytes.Repeat([]byte{81}, 32)
	if err = backup.RestoreSet(context.Background(), setPath, password, target, key, limits); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	other := admissionRequest("entry2", "192.0.2.2", "after-restore")
	pending, err := restored.AcquireAdmission(scope, other, now.Add(31*time.Second))
	if err != nil || pending.Allowed || pending.Reason != "quota-budget-pending" {
		t.Fatalf("restore refunded unknown outstanding budget: %+v %v", pending, err)
	}
	in.Final = true
	in.AdmittedBytes = 30
	for _, offset := range []time.Duration{32, 33} {
		final, err := restored.AcquireAdmission(scope, in, now.Add(offset*time.Second))
		if err != nil || final.Allowed || final.Reason != "presence-closed" {
			t.Fatalf("final: %+v %v", final, err)
		}
	}
	usage, err := restored.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 30 || usage.WeightedBytes != 30 {
		t.Fatalf("restored final replay charged incorrectly: %+v %v", usage, err)
	}
	available, err := restored.AcquireAdmission(scope, other, now.Add(34*time.Second))
	if err != nil || !available.Allowed || available.ByteBudget == nil || *available.ByteBudget != 70 {
		t.Fatalf("restored final did not release exactly unused budget: %+v %v", available, err)
	}
	live, err := s.AcquireAdmission(scope, other, now.Add(34*time.Second))
	if err != nil || live.Allowed || live.Reason != "quota-budget-pending" {
		t.Fatalf("restored settlement mutated live obligation: %+v %v", live, err)
	}
	usage, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 0 || usage.WeightedBytes != 0 {
		t.Fatalf("restored settlement mutated live usage: %+v %v", usage, err)
	}
}
