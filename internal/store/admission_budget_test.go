package store_test

import (
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func finiteAdmissionPlan(t *testing.T, s *store.Store, quota int64) {
	t.Helper()
	if e := s.Put("services", "plan", service.Plan{ID: "plan", Name: "Plan", QuotaBytes: quota, RouteIDs: []string{"route"}, OnlineIPLimit: 1}); e != nil {
		t.Fatal(e)
	}
}
func TestByteBudgetReservesWeightedPoolAndSettlesExactlyOnce(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	if e := s.SetRate(service.Rate{ID: "two", RouteID: "route", Micros: 2 * service.RateScale, EffectiveAt: now.Add(-time.Minute)}); e != nil {
		t.Fatal(e)
	}
	in := admissionRequest("entry1", "192.0.2.1", "first")
	first, e := s.AcquireAdmission(scope, in, now)
	if e != nil || !first.Allowed || first.ByteBudget == nil || *first.ByteBudget != 50 {
		t.Fatalf("weighted reservation %+v %v", first, e)
	}
	other := admissionRequest("entry2", "192.0.2.1", "second")
	v, e := s.AcquireAdmission(scope, other, now)
	if e != nil || v.Allowed || v.Reason != "quota-reserved" {
		t.Fatalf("shared quota over-reserved %+v %v", v, e)
	}
	in.AdmittedBytes = 20
	v, e = s.AcquireAdmission(scope, in, now.Add(time.Second))
	if e != nil || !v.Allowed || *v.ByteBudget != 50 {
		t.Fatalf("settled reservation %+v %v", v, e)
	}
	if _, e = s.AcquireAdmission(scope, in, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 20 || usage.WeightedBytes != 40 {
		t.Fatalf("replay debit %+v %v", usage, e)
	}
	in.Final = true
	in.AdmittedBytes = 25
	v, e = s.AcquireAdmission(scope, in, now.Add(3*time.Second))
	if e != nil || v.Allowed || v.Reason != "presence-closed" {
		t.Fatalf("final %+v %v", v, e)
	}
	in.Final = false
	v, e = s.AcquireAdmission(scope, in, now.Add(4*time.Second))
	if e != nil || v.Allowed || v.Reason != "presence-closed" {
		t.Fatalf("delayed renew resurrected final %+v %v", v, e)
	}
	v, e = s.AcquireAdmission(scope, other, now.Add(4*time.Second))
	if e != nil || !v.Allowed || *v.ByteBudget != 25 {
		t.Fatalf("proven unused reservation not returned %+v %v", v, e)
	}
	usage, e = s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 25 || usage.WeightedBytes != 50 {
		t.Fatalf("final debit %+v %v", usage, e)
	}
}
func TestExpiredBudgetCannotBeReissuedUntilFinalEvidence(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "first")
	first, e := s.AcquireAdmission(scope, in, now)
	if e != nil || !first.Allowed {
		t.Fatal(e)
	}
	if e = s.ReleaseAdmission(scope, first.LeaseID, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	other := admissionRequest("entry2", "192.0.2.2", "second")
	v, e := s.AcquireAdmission(scope, other, now.Add(31*time.Second))
	if e != nil || v.Allowed || v.Reason != "quota-budget-pending" {
		t.Fatalf("expired unknown budget refunded %+v %v", v, e)
	}
	in.Final = true
	in.AdmittedBytes = 30
	v, e = s.AcquireAdmission(scope, in, now.Add(32*time.Second))
	if e != nil || v.Reason != "presence-closed" {
		t.Fatalf("late final rejected %+v %v", v, e)
	}
	v, e = s.AcquireAdmission(scope, other, now.Add(33*time.Second))
	if e != nil || !v.Allowed || *v.ByteBudget != 70 {
		t.Fatalf("reconciled pool %+v %v", v, e)
	}
}
func TestBudgetFinalAcceptsMeasuredConsumptionAfterDisable(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "first")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatal(e)
	}
	if e := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: false}); e != nil {
		t.Fatal(e)
	}
	in.AdmittedBytes = 40
	v, e := s.AcquireAdmission(scope, in, now.Add(time.Second))
	if e != nil || v.Allowed || v.Reason != "disabled" {
		t.Fatalf("revoked renew %+v %v", v, e)
	}
	in.Final = true
	in.AdmittedBytes = 45
	if _, e = s.AcquireAdmission(scope, in, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 45 {
		t.Fatalf("consumption discarded after disable %+v %v", usage, e)
	}
}
func TestFinalBeforeInitialRequestFencesDelayedGrant(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "race")
	in.Final = true
	v, e := s.AcquireAdmission(scope, in, now)
	if e != nil || v.Reason != "presence-closed" {
		t.Fatalf("unknown zero final %+v %v", v, e)
	}
	in.Final = false
	v, e = s.AcquireAdmission(scope, in, now.Add(time.Second))
	if e != nil || v.Allowed || v.Reason != "presence-closed" {
		t.Fatalf("late initial created reservation %+v %v", v, e)
	}
}
func TestBudgetPinsRateBoundaryAndPreservesLateHistoricalCharge(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	boundary := now.Add(5 * time.Second)
	if e := s.SetRate(service.Rate{ID: "two", RouteID: "route", Micros: 2 * service.RateScale, EffectiveAt: boundary}); e != nil {
		t.Fatal(e)
	}
	in := admissionRequest("entry1", "192.0.2.1", "before")
	v, e := s.AcquireAdmission(scope, in, now)
	if e != nil || !v.Allowed || !v.ExpiresAt.Equal(boundary) {
		t.Fatalf("grant crossed known boundary %+v %v", v, e)
	}
	in.Final = true
	in.AdmittedBytes = 10
	if _, e = s.AcquireAdmission(scope, in, boundary.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.WeightedBytes != 10 {
		t.Fatalf("late bytes got new multiplier %+v %v", usage, e)
	}
	after := admissionRequest("entry1", "192.0.2.1", "after")
	v, e = s.AcquireAdmission(scope, after, boundary.Add(time.Second))
	if e != nil || !v.Allowed || *v.ByteBudget != 45 {
		t.Fatalf("new multiplier reservation %+v %v", v, e)
	}
}
func TestManagedAggregateSnapshotsDoNotDoubleDebitAdmissionLedger(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "flow")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatal(e)
	}
	in.AdmittedBytes = 20
	in.Final = true
	if _, e := s.AcquireAdmission(scope, in, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	binding := store.MeterBinding{ID: "managed", InstanceID: scope.InstanceID, SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
	if e := s.SetMeterBinding(binding); e != nil {
		t.Fatal(e)
	}
	sample := store.CounterSample{SampleID: "sample", CounterEpoch: "epoch", SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget", CumulativeBytes: 20, ObservedAt: now.Add(time.Second)}
	batch := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: "stream", Sequence: 1, Digest: "digest", Samples: []store.CounterSample{sample}}
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 20 {
		t.Fatalf("managed payload double billed %+v %v", usage, e)
	}
}

func TestBudgetPolicyChangeCannotCrossIssuedReservation(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "flow")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatal(e)
	}
	if e := s.SetRate(service.Rate{ID: "overlap", RouteID: "route", Micros: 2 * service.RateScale, EffectiveAt: now.Add(time.Second)}); e == nil {
		t.Fatal("rate revision crossed already issued byte allowance")
	}
	if e := s.ManualReset("account", "manual reset", now.Add(time.Second)); e == nil {
		t.Fatal("manual reset erased unresolved issued allowance")
	}
	in.Final = true
	in.AdmittedBytes = 20
	if _, e := s.AcquireAdmission(scope, in, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	if e := s.SetRate(service.Rate{ID: "safe", RouteID: "route", Micros: 2 * service.RateScale, EffectiveAt: now.Add(3 * time.Second)}); e != nil {
		t.Fatal(e)
	}
	if e := s.ManualReset("account", "drained reset", now.Add(3*time.Second)); e != nil {
		t.Fatal(e)
	}
}

func TestIssuedBudgetsFenceQuotaReductionAndCycleChange(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "policy-fence")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatalf("initial %+v %v", v, e)
	}
	var plan service.Plan
	s.Get("services", "plan", &plan)
	plan.QuotaBytes = 50
	if e := s.PutServicePlan(plan); e == nil {
		t.Fatal("lowered quota beneath issued budget")
	}
	var ent service.Entitlement
	s.Get("entitlements", "account", &ent)
	override := int64(50)
	ent.QuotaOverride = &override
	if e := s.PutEntitlement(ent); e == nil {
		t.Fatal("override bypassed outstanding reservation")
	}
	ent.QuotaOverride = nil
	ent.Cycle = service.CyclePolicy{Mode: "fixed-days", Days: 7, Anchor: now, Timezone: "UTC+8"}
	if e := s.PutEntitlement(ent); e == nil {
		t.Fatal("changed cycle beneath issued budget")
	}
	plan.QuotaBytes = 200
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatalf("safe quota increase blocked: %v", e)
	}
	in.Final = true
	in.AdmittedBytes = 25
	if _, e := s.AcquireAdmission(scope, in, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	plan.QuotaBytes = 20
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatalf("settled quota reduction should mark exhausted, not delete usage: %v", e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 25 {
		t.Fatalf("consumption lost %+v %v", usage, e)
	}
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatalf("settled cycle change blocked: %v", e)
	}
}

func TestConcurrentStoresCannotOverReserveWeightedAccountQuota(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	if e := s.SetRate(service.Rate{ID: "fractional", RouteID: "route", Micros: 1_500_000, EffectiveAt: now.Add(-time.Minute)}); e != nil {
		t.Fatal(e)
	}
	other, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	start := make(chan struct{})
	results := make(chan store.AdmissionDecision, 2)
	errors := make(chan error, 2)
	for i, db := range []*store.Store{s, other} {
		go func(i int, db *store.Store) {
			<-start
			v, e := db.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", fmt.Sprintf("parallel-%d", i)), now)
			results <- v
			errors <- e
		}(i, db)
	}
	close(start)
	total := uint64(0)
	allowed := 0
	for range 2 {
		v := <-results
		if e := <-errors; e != nil {
			t.Fatal(e)
		}
		if v.Allowed {
			allowed++
			if v.ByteBudget == nil {
				t.Fatal("finite quota received unlimited ceiling")
			}
			total += *v.ByteBudget
		}
	}
	if allowed != 1 || total != 66 {
		t.Fatalf("concurrent weighted reservations count=%d raw=%d", allowed, total)
	}
}

func TestOverBudgetEvidenceIsRetainedWithoutInventingAttribution(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "overrun")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatal(e)
	}
	in.AdmittedBytes = 101
	in.Final = true
	if _, e := s.AcquireAdmission(scope, in, now.Add(time.Second)); e != store.ErrAdmissionEvidence {
		t.Fatalf("overrun not rejected: %v", e)
	}
	history, e := s.List("admission-anomalies")
	if e != nil || len(history) != 1 {
		t.Fatalf("measured anomaly discarded: %v", e)
	}
	hold, e := s.HasAccountingHold("account")
	if e != nil || !hold {
		t.Fatal("uncertain accounting did not restrict admission")
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 0 {
		t.Fatalf("invented attribution %+v %v", usage, e)
	}
}

func TestQueuedAdmissionCannotIgnoreLaterCommittedSettlement(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	other, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "first-serialized")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatal(e)
	}
	in.Final = true
	in.AdmittedBytes = 100
	if _, e := s.AcquireAdmission(scope, in, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	// This HTTP request arrived before Final, but waits for its transaction. Its
	// arrival timestamp must not hide consumption already committed in SQLite.
	v, e := other.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.1", "queued-before-final"), now.Add(time.Millisecond))
	if e != nil || v.Allowed {
		t.Fatalf("stale request-time refunded committed consumption %+v %v", v, e)
	}
}
