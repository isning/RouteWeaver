package store_test

import (
	"bytes"
	"errors"
	"path/filepath"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func policyEditFixture(t *testing.T) (*store.Store, service.Plan, time.Time) {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "policy.db"), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	plan := service.Plan{ID: "plan", Name: "Standard", QuotaBytes: 50, RouteIDs: []string{}, Cycle: service.CyclePolicy{Mode: "monthly", Day: 1, Timezone: "UTC+8", Anchor: now.AddDate(0, -1, 0)}}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	return s, plan, now
}

func TestServiceEditCreationRequiresAbsenceAndNeverBecomesAnUpdate(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	opened, err := s.ServicePolicyEditContext("new-plan")
	if err != nil || opened.Record != nil || opened.Precondition.Exists || opened.Precondition.Revision == "" {
		t.Fatalf("missing creation baseline: %+v %v", opened, err)
	}
	plan.ID = "new-plan"
	change := service.PolicyChange{Service: &plan}
	preview, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.Before != nil || preview.Resource.After.Service.ID != "new-plan" {
		t.Fatalf("wrong creation review: %+v %v", preview, err)
	}
	stillAbsent, err := s.ServicePolicyEditContext("new-plan")
	if err != nil || stillAbsent.Record != nil {
		t.Fatalf("preview persisted a plan: %+v %v", stillAbsent, err)
	}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(change, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("absence token became upsert: %v", err)
	}
	if _, err := s.ApplyPolicyChange(change, preview.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("creation crossed another writer: %v", err)
	}
	plan.ID = "another-new-plan"
	if _, err := s.PreviewPolicyEdit(change, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("absence token transplanted to another ID: %v", err)
	}
}

func TestServiceEditKeepsTargetBaselineAndBroadApplySnapshotSeparate(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	opened, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	other := plan
	other.ID = "other"
	if err := s.PutServicePlan(other); err != nil {
		t.Fatal(err)
	}
	opened.Record.Service.QuotaBytes = 100
	review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatalf("unrelated pre-preview update invalidated opened target: %v", err)
	}
	other.Name = "Updated other offering"
	if err := s.PutServicePlan(other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, review.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("broad apply snapshot was weakened: %v", err)
	}
	review, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	changed := *opened.Record.Service
	changed.Cycle.Day = 20
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Service: &changed}, review.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("different hidden candidate reused ticket: %v", err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, review.Revision, now); err != nil {
		t.Fatal(err)
	}
}

func TestServiceEditReportsStaleBaselineBeforeValidatingOldRouteReferences(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	if err := s.Put("routes", "old-route", domain.Route{ID: "old-route", Name: "Old route"}); err != nil {
		t.Fatal(err)
	}
	plan.RouteIDs = []string{"old-route"}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	opened, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	plan.RouteIDs = []string{}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("routes", "old-route"); err != nil {
		t.Fatal(err)
	}
	opened.Record.Service.QuotaBytes = 100
	if review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || review.Revision != "" {
		t.Fatalf("old reference obscured the opening conflict: %+v %v", review, err)
	}
	current, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	current.Record.Service.RouteIDs = []string{"old-route"}
	if _, err := s.PreviewPolicyEdit(*current.Record, current.Precondition, now); err == nil || errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("current baseline bypassed reference validation: %v", err)
	}
}

func TestServiceEditBaselineCoversHiddenFieldsButUsesContentEquivalentIdentity(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	opened, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	changed := plan
	changed.Cycle.Anchor = changed.Cycle.Anchor.Add(time.Second)
	if err := s.PutServicePlan(changed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("hidden anchor update was not fenced: %v", err)
	}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	equivalent, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil || equivalent.Precondition != opened.Precondition {
		t.Fatalf("re-encryption changed logical baseline: %+v %v", equivalent, err)
	}
	if err := s.Remove("services", plan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("deleted offering became recreation: %v", err)
	}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); err != nil {
		t.Fatalf("identical logical recreation must remain equivalent, not incarnation fenced: %v", err)
	}
	other := plan
	other.ID = "same-name"
	if err := s.PutServicePlan(other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(service.PolicyChange{Service: &other}, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("same label accepted another ID's baseline: %v", err)
	}
}

func TestServiceEditTypedSnapshotsRetainInactiveCycleFieldsAndRoutePresence(t *testing.T) {
	for _, routeIDs := range [][]string{nil, {}} {
		name := "empty routes"
		if routeIDs == nil {
			name = "nil routes"
		}
		t.Run(name, func(t *testing.T) {
			s, plan, now := policyEditFixture(t)
			plan.RouteIDs = routeIDs
			plan.Cycle = service.CyclePolicy{Mode: "anniversary", Day: 28, Days: 19, Timezone: "Asia/Shanghai", Anchor: time.Date(2026, 1, 31, 2, 3, 4, 123456789, time.FixedZone("offset", 8*60*60))}
			if err := s.PutServicePlan(plan); err != nil {
				t.Fatal(err)
			}
			opened, err := s.ServicePolicyEditContext(plan.ID)
			if err != nil {
				t.Fatal(err)
			}
			got := opened.Record.Service
			if got.Cycle.Day != 28 || got.Cycle.Days != 19 || got.Cycle.Timezone != "Asia/Shanghai" || !got.Cycle.Anchor.Equal(plan.Cycle.Anchor) || got.Cycle.Anchor.Nanosecond() != 123456789 || !reflect.DeepEqual(got.RouteIDs, routeIDs) {
				t.Fatalf("typed opening snapshot lost semantic fields: %+v", got)
			}
			got.QuotaBytes = 100
			review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
			if err != nil {
				t.Fatal(err)
			}
			if review.Resource == nil || review.Resource.Before == nil {
				t.Fatalf("missing resource comparison: %+v", review)
			}
			for _, snapshot := range []*service.Plan{review.Resource.Before.Service, review.Resource.After.Service} {
				if snapshot.Cycle.Day != 28 || snapshot.Cycle.Days != 19 || snapshot.Cycle.Timezone != "Asia/Shanghai" || !snapshot.Cycle.Anchor.Equal(plan.Cycle.Anchor) || snapshot.Cycle.Anchor.Nanosecond() != 123456789 || !reflect.DeepEqual(snapshot.RouteIDs, routeIDs) {
					t.Fatalf("typed resource snapshot lost semantic fields: %+v", snapshot)
				}
			}
		})
	}
}

func TestServiceEditRejectsUnsupportedStoredShapeWithoutDiscardingIt(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	opened, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored := map[string]any{"id": plan.ID, "name": plan.Name, "quotaBytes": 50, "routeIds": []string{}, "cycle": map[string]any{"mode": "none", "timezone": "UTC+8", "futureRule": true}}
	if err := s.Put("services", plan.ID, stored); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ServicePolicyEditContext(plan.ID); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) {
		t.Fatalf("unknown nested field entered typed editor: %v", err)
	}
	if review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) || review.Revision != "" {
		t.Fatalf("unknown field silently discarded: %+v %v", review, err)
	}
	var retained map[string]any
	if err := s.Get("services", plan.ID, &retained); err != nil {
		t.Fatal(err)
	}
	if retained["cycle"].(map[string]any)["futureRule"] != true {
		t.Fatal("unsupported saved data was rewritten")
	}
}

func TestServiceResourceReviewKeepsEstablishedCalendarAndUsageSeparate(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	if err := s.PutUser(domain.User{ID: "account", Name: "User", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	accountCycle := service.CyclePolicy{Mode: "monthly", Day: 7, Anchor: now.AddDate(0, -2, 0), Timezone: "UTC+8"}
	if err := s.PutEntitlement(service.Entitlement{UserID: "account", ServiceID: plan.ID, StartsAt: now.Add(-time.Hour), Cycle: accountCycle}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "meter", Epoch: "one", Sequence: 1, RawBytes: 10, ObservedAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	opened, err := s.ServicePolicyEditContext(plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	opened.Record.Service.Cycle.Day = 15
	opened.Record.Service.QuotaBytes = 100
	review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if review.Resource == nil || review.Resource.Before == nil || review.Resource.Before.Service.Cycle.Day != 1 || review.Resource.After.Service.Cycle.Day != 15 || len(review.Affected) != 1 || review.Affected[0].Before.Entitlement.Cycle != accountCycle || review.Affected[0].After.Entitlement.Cycle != accountCycle {
		t.Fatalf("resource defaults were confused with account calendar: %+v", review)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, review.Revision, now); err != nil {
		t.Fatal(err)
	}
	effective, err := s.EffectivePolicy("account", now)
	if err != nil || effective.Entitlement.Cycle != accountCycle || effective.QuotaBytes != 100 {
		t.Fatalf("account calendar changed: %+v %v", effective, err)
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 10 {
		t.Fatalf("plan change cleared usage: %+v %v", usage, err)
	}
}

func TestGuardedServiceEditStillBlocksQuotaReductionAcrossIssuedBudgets(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	if err := s.Put("routes", "route", domain.Route{ID: "route", Name: "Route"}); err != nil {
		t.Fatal(err)
	}
	finiteAdmissionPlan(t, s, 100)
	if admitted, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "guarded-edit"), now); err != nil || !admitted.Allowed {
		t.Fatalf("admission: %+v %v", admitted, err)
	}
	opened, err := s.ServicePolicyEditContext("plan")
	if err != nil {
		t.Fatal(err)
	}
	opened.Record.Service.QuotaBytes = 50
	review, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil || len(review.Blockers) == 0 {
		t.Fatalf("guarded preview bypassed issued budget: %+v %v", review, err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, review.Revision, now); err == nil {
		t.Fatal("guarded apply bypassed issued budget")
	}
	saved, err := s.ServicePolicyEditContext("plan")
	if err != nil || saved.Record.Service.QuotaBytes != 100 {
		t.Fatalf("blocked edit leaked: %+v %v", saved, err)
	}
}

// The public edit/read, preview and apply seams reproduce two independent editors.
// This is authored before implementation; no red/green runtime result is claimed.
func TestServiceEditRejectsOpeningDraftAfterAnotherEditorChangesDefaults(t *testing.T) {
	s, _, now := policyEditFixture(t)
	a, err := s.ServicePolicyEditContext("plan")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.ServicePolicyEditContext("plan")
	if err != nil {
		t.Fatal(err)
	}
	b.Record.Service.Cycle.Day = 15
	bPreview, err := s.PreviewPolicyEdit(*b.Record, b.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*b.Record, bPreview.Revision, now); err != nil {
		t.Fatal(err)
	}
	a.Record.Service.QuotaBytes = 100
	stale, err := s.PreviewPolicyEdit(*a.Record, a.Precondition, now)
	if !errors.Is(err, store.ErrPolicyEditBaselineChanged) || stale.Revision != "" {
		t.Fatalf("stale opening draft received a review: %+v %v", stale, err)
	}
	saved, err := s.ServicePolicyEditContext("plan")
	if err != nil || saved.Record.Service.Cycle.Day != 15 || saved.Record.Service.QuotaBytes != 50 {
		t.Fatalf("stale draft changed the saved offering: %+v %v", saved, err)
	}
	// Explicit reconciliation uses a newly opened record, not a new token on a's draft.
	saved.Record.Service.QuotaBytes = 100
	review, err := s.PreviewPolicyEdit(*saved.Record, saved.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if review.Guard != "opened-record" || review.Resource == nil || review.Resource.Before == nil || review.Resource.Before.Service.Cycle.Day != 15 || review.Resource.After.Service.Cycle.Day != 15 || review.Resource.Before.Service.QuotaBytes != 50 || review.Resource.After.Service.QuotaBytes != 100 || len(review.Affected) != 0 {
		t.Fatalf("wrong zero-user resource review: %+v", review)
	}
	if _, err := s.ApplyPolicyChange(*saved.Record, review.Revision, now); err != nil {
		t.Fatal(err)
	}
	final, err := s.ServicePolicyEditContext("plan")
	if err != nil || final.Record.Service.QuotaBytes != 100 || final.Record.Service.Cycle.Day != 15 {
		t.Fatalf("reconciled update lost defaults: %+v %v", final, err)
	}
}
