package store_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestGroupPreviewApplySharesAdmissionPolicyAndRejectsStaleRevision(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	ent := service.Entitlement{UserID: "account", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatal(e)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "g", Name: "Members", ServiceID: "plan", Priority: 10, MemberIDs: []string{"account"}}}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil || len(preview.Affected) != 1 || preview.Affected[0].After.ServiceID != "plan" || len(preview.Blockers) != 0 {
		t.Fatalf("preview %+v %v", preview, e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e != nil {
		t.Fatal(e)
	}
	policy, e := s.EffectivePolicy("account", now)
	if e != nil || policy.ServiceID != "plan" || policy.Entitlement.Cycle != ent.Cycle {
		t.Fatalf("effective %+v %v", policy, e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e == nil {
		t.Fatal("stale preview applied")
	}
	lease, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "group-flow"), now)
	if e != nil || !lease.Allowed || lease.EntryRateBPS != 1024 {
		t.Fatalf("group not enforced %+v %v", lease, e)
	}
}

func TestPolicyPreviewBindsExactChangeAndInitialCycleAnchor(t *testing.T) {
	s, _, _, _, now := admissionFixture(t)
	if e := s.Remove("entitlements", "account"); e != nil {
		t.Fatal(e)
	}
	var plan service.Plan
	if e := s.Get("services", "plan", &plan); e != nil {
		t.Fatal(e)
	}
	plan.Cycle = service.CyclePolicy{Mode: "anniversary", Timezone: "UTC+8"}
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatal(e)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "g", Name: "Members", ServiceID: "plan", Priority: 1, MemberIDs: []string{"account"}}}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil {
		t.Fatal(e)
	}
	changed := *change.Group
	changed.Priority = 2
	if _, e = s.ApplyPolicyChange(service.PolicyChange{Group: &changed}, preview.Revision, now.Add(time.Second)); e != store.ErrConflict {
		t.Fatalf("different change reused preview: %v", e)
	}
	applied, e := s.ApplyPolicyChange(change, preview.Revision, now.Add(time.Minute))
	if e != nil {
		t.Fatal(e)
	}
	if !applied.Affected[0].After.Entitlement.Cycle.Anchor.Equal(preview.Affected[0].After.Entitlement.Cycle.Anchor) || !applied.Affected[0].After.Entitlement.StartsAt.Equal(now) {
		t.Fatal("apply changed reviewed cycle anchor")
	}
}

func TestGroupChangesCannotDiscardIssuedBudgetOrSilentlyStackServices(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	ent := service.Entitlement{UserID: "account", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "monthly", Day: 15, Anchor: now.AddDate(0, -2, 0), Timezone: "UTC+8"}}
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatal(e)
	}
	group := service.Group{ID: "g", Name: "Members", ServiceID: "plan", Priority: 1, MemberIDs: []string{"account"}}
	apply := func(change service.PolicyChange) error {
		p, e := s.PreviewPolicyChange(change, now)
		if e != nil {
			return e
		}
		_, e = s.ApplyPolicyChange(change, p.Revision, now)
		return e
	}
	if e := apply(service.PolicyChange{Group: &group}); e != nil {
		t.Fatal(e)
	}
	if e := s.PutServicePlan(service.Plan{ID: "limited", Name: "Limited", QuotaBytes: 100, RouteIDs: []string{"route"}, EntryRateBPS: 512}); e != nil {
		t.Fatal(e)
	}
	in := admissionRequest("entry1", "192.0.2.1", "active")
	if v, e := s.AcquireAdmission(scope, in, now); e != nil || !v.Allowed {
		t.Fatalf("admit %+v %v", v, e)
	}
	group.ServiceID = "limited"
	preview, e := s.PreviewPolicyChange(service.PolicyChange{Group: &group}, now)
	if e != nil || len(preview.Blockers) == 0 {
		t.Fatalf("unsafe group change preview %+v %v", preview, e)
	}
	if _, e = s.ApplyPolicyChange(service.PolicyChange{Group: &group}, preview.Revision, now); e == nil {
		t.Fatal("unsafe group change applied")
	}
	current, e := s.EffectivePolicy("account", now)
	if e != nil || current.ServiceID != "plan" {
		t.Fatalf("blocked change leaked %+v %v", current, e)
	}
	in.Final = true
	if _, e = s.AcquireAdmission(scope, in, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	if e = apply(service.PolicyChange{Group: &group}); e != nil {
		t.Fatal(e)
	}
	current, e = s.EffectivePolicy("account", now)
	if e != nil || current.ServiceID != "limited" || current.Entitlement.Cycle != ent.Cycle {
		t.Fatalf("safe membership reset cycle %+v %v", current, e)
	}
	tie := service.Group{ID: "tie", Name: "Conflicting", ServiceID: "plan", Priority: 1, MemberIDs: []string{"account"}}
	preview, e = s.PreviewPolicyChange(service.PolicyChange{Group: &tie}, now)
	if e != nil || len(preview.Blockers) == 0 || preview.Affected[0].After.Status != "ambiguous" {
		t.Fatalf("ambiguous preview %+v %v", preview, e)
	}
	if _, e = s.ApplyPolicyChange(service.PolicyChange{Group: &tie}, preview.Revision, now); e == nil {
		t.Fatal("ambiguous assignment committed")
	}
}

func TestGroupPreviewCASSerializesIndependentStoreWriters(t *testing.T) {
	s, path, key, _, now := admissionFixture(t)
	other, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	changes := []service.PolicyChange{{Group: &service.Group{ID: "a", Name: "A", ServiceID: "plan", MemberIDs: []string{"account"}}}, {Group: &service.Group{ID: "b", Name: "B", ServiceID: "plan", MemberIDs: []string{"account"}}}}
	previews := make([]service.PolicyPreview, 2)
	for i, c := range changes {
		previews[i], e = s.PreviewPolicyChange(c, now)
		if e != nil {
			t.Fatal(e)
		}
	}
	start := make(chan struct{})
	result := make(chan error, 2)
	for i, db := range []*store.Store{s, other} {
		go func(i int, db *store.Store) {
			<-start
			_, e := db.ApplyPolicyChange(changes[i], previews[i].Revision, now)
			result <- e
		}(i, db)
	}
	close(start)
	success, conflict := 0, 0
	for range 2 {
		e := <-result
		if e == nil {
			success++
		} else if e == store.ErrConflict {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("CAS successes=%d conflicts=%d", success, conflict)
	}
}

func TestProvisioningPolicyFenceRejectsConcurrentGroupRemoval(t *testing.T) {
	s, _, _, _, now := admissionFixture(t)
	if e := s.PutEntitlement(service.Entitlement{UserID: "account", Cycle: service.CyclePolicy{Mode: "none"}}); e != nil {
		t.Fatal(e)
	}
	group := service.Group{ID: "g", Name: "G", ServiceID: "plan", MemberIDs: []string{"account"}}
	change := service.PolicyChange{Group: &group}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e != nil {
		t.Fatal(e)
	}
	expected, e := s.EffectivePolicy("account", now)
	if e != nil {
		t.Fatal(e)
	}
	group.MemberIDs = []string{}
	change = service.PolicyChange{Group: &group}
	preview, e = s.PreviewPolicyChange(change, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e != nil {
		t.Fatal(e)
	}
	if e = s.ComparePolicyAndPutRecords(expected, nil, []store.RecordWrite{{Kind: "provisioned", ID: "test", Value: true}}); e != store.ErrConflict {
		t.Fatalf("stale group policy provisioned: %v", e)
	}
	var got bool
	if e = s.Get("provisioned", "test", &got); e != store.ErrNotFound {
		t.Fatal("stale provisioning wrote partial result")
	}
}

func TestFirstGroupCalendarPreservesExistingDirectRouteBudget(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	if e := s.Remove("entitlements", "account"); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("routes", "route", domain.Route{ID: "route", Name: "Route", UserIDs: []string{"account"}}); e != nil {
		t.Fatal(e)
	}
	if v, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "legacy-budget"), now); e != nil || !v.Allowed {
		t.Fatalf("legacy %+v %v", v, e)
	}
	var plan service.Plan
	if e := s.Get("services", "plan", &plan); e != nil {
		t.Fatal(e)
	}
	plan.Cycle = service.CyclePolicy{Mode: "anniversary", Timezone: "UTC+8"}
	plan.EntryRateBPS = 0 // Isolate calendar preservation, not a concurrent rate reduction.
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatal(e)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "g", Name: "G", ServiceID: "plan", MemberIDs: []string{"account"}}}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil || len(preview.Blockers) != 0 {
		t.Fatalf("legacy no-reset calendar preview: %+v %v", preview, e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e != nil {
		t.Fatal(e)
	}
	policy, e := s.EffectivePolicy("account", now)
	if e != nil || policy.Entitlement.Cycle.Mode != "none" || !policy.Entitlement.Cycle.Anchor.IsZero() {
		t.Fatalf("first group replaced live implicit calendar: %+v %v", policy, e)
	}

}

func TestFirstGroupAssignmentDoesNotEraseSettledLegacyUsage(t *testing.T) {
	s, _, _, _, now := admissionFixture(t)
	if e := s.Remove("entitlements", "account"); e != nil {
		t.Fatal(e)
	}
	if e := s.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "legacy", Epoch: "one", Sequence: 1, RawBytes: 50, ObservedAt: now.Add(-time.Hour)}); e != nil {
		t.Fatal(e)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "g", Name: "G", ServiceID: "plan", MemberIDs: []string{"account"}}}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now); e != nil {
		t.Fatal(e)
	}
	policy, e := s.EffectivePolicy("account", now)
	if e != nil {
		t.Fatal(e)
	}
	window, e := policy.Entitlement.Cycle.Window(now)
	if e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", window.Start, time.Time{})
	if e != nil || usage.RawBytes != 50 {
		t.Fatalf("first group silently reset prior usage: %+v %v", usage, e)
	}
}

func TestFirstGroupPreviewRejectsInterveningLegacyUsage(t *testing.T) {
	s, _, _, _, now := admissionFixture(t)
	if e := s.Remove("entitlements", "account"); e != nil {
		t.Fatal(e)
	}
	change := service.PolicyChange{Group: &service.Group{ID: "g", Name: "G", ServiceID: "plan", MemberIDs: []string{"account"}}}
	preview, e := s.PreviewPolicyChange(change, now)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "newly-settled", Epoch: "one", Sequence: 1, RawBytes: 50, ObservedAt: now}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ApplyPolicyChange(change, preview.Revision, now.Add(time.Second)); e != store.ErrConflict {
		t.Fatalf("initial calendar changed since preview but was applied: %v", e)
	}
}
