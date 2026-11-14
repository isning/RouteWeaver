package store

import (
	"errors"
	"testing"
)

func putAttributionMigrationLock(t *testing.T, s *Store, owner, output, revision, dep, migration, state string) {
	t.Helper()
	r := attributionMigrationReceipt{ID: migration, Owner: owner, OutputID: output, OutputRevision: revision, DeploymentID: dep, State: state}
	if e := s.Put("principal-service-migrations", migration, r); e != nil {
		t.Fatal(e)
	}
	l := attributionProvisioningLock{Owner: owner, OutputID: output, OutputRevision: revision, MigrationID: migration}
	if e := s.Put("principal-provisioning-locks", dep, l); e != nil {
		t.Fatal(e)
	}
}
func TestAttributedPublicationRequiresExactAppliedMigrationLocks(t *testing.T) {
	s, _, _ := attributionFixture(t)
	intent := map[string]any{"revision": "rev", "state": "provisioning", "migrationIds": map[string]string{"deployment": "migration"}}
	if e := s.TenantPut("owner", "output-attribution-intents", "output", intent); e != nil {
		t.Fatal(e)
	}
	q := OutputAttributionQueueRecord("owner", "output")
	if e := s.Put(q.Kind, q.ID, q.Value); e != nil {
		t.Fatal(e)
	}
	out := attributedTestOutput("output", "token")
	publish := func() error {
		return s.CompareInputsAndPublishAttributedOutput(attributionPublicationFence(t, s), "owner", "output", "rev", out, out["tokenDigest"].(string), nil, nil)
	}
	if e := publish(); !errors.Is(e, ErrConflict) {
		t.Fatalf("missing lock accepted %v", e)
	}
	putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "queued")
	if e := publish(); !errors.Is(e, ErrConflict) {
		t.Fatalf("unapplied receipt accepted %v", e)
	}
	putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "applied")
	if e := s.Put("principal-provisioning-locks", "deployment", attributionProvisioningLock{Owner: "other", OutputID: "other", OutputRevision: "rev", MigrationID: "other"}); e != nil {
		t.Fatal(e)
	}
	if e := publish(); !errors.Is(e, ErrConflict) {
		t.Fatalf("foreign lock accepted %v", e)
	}
	var state outputAttributionIntent
	if e := s.TenantGet("owner", "output-attribution-intents", "output", &state); e != nil || state.State != "provisioning" {
		t.Fatal("partial publication")
	}
	if _, e := s.LookupToken("feeds", out["tokenDigest"].(string)); e != ErrNotFound {
		t.Fatal("partial token")
	}
	putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "applied")
	if e := publish(); e != nil {
		t.Fatal(e)
	}
	var lock attributionProvisioningLock
	if e := s.Get("principal-provisioning-locks", "deployment", &lock); e != ErrNotFound {
		t.Fatal("successful publish retained lock")
	}
}
func TestAttributedCancellationReleasesLocksOnlyAfterCompensation(t *testing.T) {
	s, _, _ := attributionFixture(t)
	intent := map[string]any{"revision": "rev", "state": "provisioning", "migrationIds": map[string]string{"deployment": "migration", "never-started": "never-migration"}, "extra": "retained"}
	if e := s.TenantPut("owner", "output-attribution-intents", "output", intent); e != nil {
		t.Fatal(e)
	}
	putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "applied")
	if e := s.CompareInputsAndCancelAttributedOutput("owner", "output", "rev", nil, nil, nil); e != nil {
		t.Fatal(e)
	}
	var lock attributionProvisioningLock
	if e := s.Get("principal-provisioning-locks", "deployment", &lock); e != nil {
		t.Fatal("cancel released lock before compensation")
	}
	finish := func() error {
		return s.CompareInputsAndFinishAttributedCancellation("owner", "output", "rev", nil, nil)
	}
	if e := finish(); !errors.Is(e, ErrConflict) {
		t.Fatalf("uncompensated cancellation completed %v", e)
	}
	q := OutputAttributionQueueRecord("owner", "output")
	var item OutputAttributionQueueItem
	if e := s.Get(q.Kind, q.ID, &item); e != nil {
		t.Fatal("failed cleanup lost queue")
	}
	putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "compensated")
	// An unrelated lock at the never-queued deployment must not be removed.
	if e := s.Put("principal-provisioning-locks", "never-started", attributionProvisioningLock{Owner: "other"}); e != nil {
		t.Fatal(e)
	}
	if e := finish(); e != nil {
		t.Fatal(e)
	}
	if e := s.Get("principal-provisioning-locks", "never-started", &lock); e != nil || lock.Owner != "other" {
		t.Fatal("foreign lock changed")
	}
	if e := s.Get("principal-provisioning-locks", "deployment", &lock); e != ErrNotFound {
		t.Fatal("completed lock retained")
	}
	if e := s.Get(q.Kind, q.ID, &item); e != ErrNotFound {
		t.Fatal("completed queue retained")
	}
	var raw map[string]any
	if e := s.TenantGet("owner", "output-attribution-intents", "output", &raw); e != nil || raw["state"] != "cancelled" || raw["extra"] != "retained" {
		t.Fatalf("terminal state %+v %v", raw, e)
	}
}
