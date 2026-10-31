package store_test

import (
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestReviewedFinalBudgetRecoveryRequiresExactStateAndKeepsAudit(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "recover-presence")
	first, e := s.AcquireAdmission(scope, in, now)
	if e != nil || !first.Allowed {
		t.Fatal(e)
	}
	rows, e := s.AdmissionBudgetReviews(scope.InstanceID, now.Add(time.Minute))
	if e != nil || len(rows) != 1 {
		t.Fatalf("review %+v %v", rows, e)
	}
	cmd := store.AdmissionBudgetResolution{LeaseID: first.LeaseID, ExpectedDigest: rows[0].Digest, AdmittedBytes: 25, RuntimeStopped: true, Reason: "Verified durable final evidence after stopping synthetic runtime", Evidence: "isolated-final-fixture", ActorID: "operator"}
	stale := cmd
	stale.ExpectedDigest = "stale"
	if e = s.ResolveAdmissionBudget(scope.InstanceID, stale, now.Add(time.Minute)); e == nil {
		t.Fatal("stale reviewed state accepted")
	}
	unstopped := cmd
	unstopped.RuntimeStopped = false
	if e = s.ResolveAdmissionBudget(scope.InstanceID, unstopped, now.Add(time.Minute)); e == nil {
		t.Fatal("live runtime settlement accepted")
	}
	if e = s.ResolveAdmissionBudget(scope.InstanceID, cmd, now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 25 {
		t.Fatalf("recovered debit %+v %v", usage, e)
	}
	records, e := s.List("admission-budget-resolutions")
	if e != nil || len(records) != 1 {
		t.Fatal("resolution evidence missing")
	}
	in.AdmittedBytes = 25
	v, e := s.AcquireAdmission(scope, in, now.Add(61*time.Second))
	if e != nil || v.Allowed || v.Reason != "presence-closed" {
		t.Fatalf("recovered presence resurrected %+v %v", v, e)
	}
	v, e = s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.2", "after-recovery"), now.Add(61*time.Second))
	if e != nil || !v.Allowed || *v.ByteBudget != 75 {
		t.Fatalf("recovery did not preserve residual quota %+v %v", v, e)
	}
}
