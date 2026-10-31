package store_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func entitlementEditFixture(t *testing.T, present bool) (*store.Store, service.Entitlement, time.Time) {
	t.Helper()
	s, plan, now := policyEditFixture(t)
	if err := s.PutUser(domain.User{ID: "subject", Name: "Subject", Enabled: true, QuotaBytes: 50}); err != nil {
		t.Fatal(err)
	}
	expiry := now.AddDate(1, 0, 0)
	ent := service.Entitlement{UserID: "subject", ServiceID: plan.ID, StartsAt: now.AddDate(0, -1, 0), ExpiresAt: &expiry, Cycle: plan.Cycle}
	if present {
		if err := s.PutEntitlement(ent); err != nil {
			t.Fatal(err)
		}
	}
	return s, ent, now
}

func applyEntitlementEdit(t *testing.T, s *store.Store, change service.PolicyChange, expected service.PolicyEditPrecondition, now time.Time) service.PolicyPreview {
	t.Helper()
	preview, err := s.PreviewPolicyEdit(change, expected, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(change, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	return preview
}

func TestEntitlementEditRejectsOpeningDraftAndPreservesCalendarExpiryAndUsage(t *testing.T) {
	s, _, now := entitlementEditFixture(t, true)
	if err := s.RecordUsage("subject", "before-edit", 7); err != nil {
		t.Fatal(err)
	}
	beforeRows := map[string][]json.RawMessage{}
	for _, kind := range []string{"users", "usage", "ledger", "resets"} {
		var err error
		beforeRows[kind], err = s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
	}
	a, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	b.Record.Entitlement.Cycle.Day = 15
	expiry := now.AddDate(2, 0, 0)
	b.Record.Entitlement.ExpiresAt = &expiry
	applyEntitlementEdit(t, s, *b.Record, b.Precondition, now)
	quota := int64(100)
	a.Record.Entitlement.QuotaOverride = &quota
	if preview, err := s.PreviewPolicyEdit(*a.Record, a.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || preview.Revision != "" {
		t.Fatalf("stale full entitlement got a ticket: %+v %v", preview, err)
	}
	fresh, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil || fresh.Record.Entitlement.Cycle.Day != 15 || !fresh.Record.Entitlement.ExpiresAt.Equal(expiry) || fresh.Effective == nil || fresh.Effective.Entitlement.Cycle.Day != 15 {
		t.Fatalf("concurrent values lost or incoherent context: %+v %v", fresh, err)
	}
	fresh.Record.Entitlement.QuotaOverride = &quota
	preview := applyEntitlementEdit(t, s, *fresh.Record, fresh.Precondition, now)
	if preview.Guard != "opened-record" || preview.Resource == nil || preview.Resource.Target != (service.PolicyResourceTarget{Kind: "entitlement", ID: "subject"}) || preview.Resource.Before.Entitlement.Cycle.Day != 15 || preview.Resource.After.Entitlement.Cycle.Day != 15 || *preview.Resource.After.Entitlement.QuotaOverride != 100 {
		t.Fatalf("resource review lost authoritative calendar: %+v", preview)
	}
	for kind, before := range beforeRows {
		after, err := s.List(kind)
		if err != nil || !reflect.DeepEqual(after, before) {
			t.Fatalf("entitlement edit changed raw %s rows: %s %v", kind, after, err)
		}
	}
}

func TestEntitlementEditAbsentSeedDoesNotMaterializeAndConflictsWithFirstGroup(t *testing.T) {
	s, _, now := entitlementEditFixture(t, false)
	opened, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil || opened.Record != nil || opened.Precondition.Exists || opened.Precondition.Revision == "" || opened.Effective == nil {
		t.Fatalf("absence is not explicit: %+v %v", opened, err)
	}
	seed := opened.Effective.Entitlement
	if seed.UserID != "subject" || seed.Cycle.Mode != "none" || seed.Cycle.Timezone != "UTC+8" || !seed.StartsAt.IsZero() || !seed.Cycle.Anchor.IsZero() || seed.ServiceID != "" {
		t.Fatalf("synthetic seed changed calendar defaults: %+v", seed)
	}
	change := service.PolicyChange{Entitlement: &seed}
	preview, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.Before != nil || preview.Resource.After.Entitlement == nil || len(preview.Affected) != 0 {
		t.Fatalf("zero-impact absent creation hidden: %+v %v", preview, err)
	}
	var saved service.Entitlement
	if err := s.Get("entitlements", "subject", &saved); err != store.ErrNotFound {
		t.Fatalf("read/preview created row: %+v %v", saved, err)
	}
	group := service.PolicyChange{Group: &service.Group{ID: "first-group", Name: "First", ServiceID: "plan", MemberIDs: []string{"subject"}}}
	groupPreview, err := s.PreviewPolicyChange(group, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(group, groupPreview.Revision, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.Get("entitlements", "subject", &saved); err != nil || saved.Cycle.Mode != "monthly" || saved.Cycle.Day != 1 || !saved.StartsAt.Equal(now) || !saved.Cycle.Anchor.Equal(now) {
		t.Fatalf("first-group initialization changed: %+v %v", saved, err)
	}
	seed.Paused = true
	if rejected, err := s.PreviewPolicyEdit(change, opened.Precondition, now.Add(time.Minute)); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || rejected.Revision != "" {
		t.Fatalf("old synthetic draft overwrote first calendar: %+v %v", rejected, err)
	}
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Entitlement: &opened.Effective.Entitlement}, preview.Revision, now.Add(time.Minute)); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("absence preview crossed first assignment: %v", err)
	}
}

func TestEntitlementEditAbsentCreationAdoptsDisplayedCycleWithoutLaterInitialization(t *testing.T) {
	s, _, now := entitlementEditFixture(t, false)
	opened, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	change := service.PolicyChange{Entitlement: &opened.Effective.Entitlement}
	preview := applyEntitlementEdit(t, s, change, opened.Precondition, now)
	if preview.Resource == nil || preview.Resource.Before != nil || len(preview.Affected) != 0 {
		t.Fatalf("creation consequence has no authoritative presence: %+v", preview)
	}
	group := service.PolicyChange{Group: &service.Group{ID: "later-group", Name: "Later", ServiceID: "plan", MemberIDs: []string{"subject"}}}
	p, err := s.PreviewPolicyChange(group, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(group, p.Revision, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.EntitlementPolicyEditContext("subject", now.Add(time.Hour))
	if err != nil || !fresh.Precondition.Exists || !reflect.DeepEqual(fresh.Record.Entitlement, change.Entitlement) || fresh.Effective.ServiceID != "plan" {
		t.Fatalf("later group reinitialized established account calendar: %+v %v", fresh, err)
	}
}

func TestEntitlementEditContextKeepsTypedValuesSeparateFromEffectiveSeed(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		name := "inherited"
		if explicit {
			name = "explicit zero and empty"
		}
		t.Run(name, func(t *testing.T) {
			s, ent, now := entitlementEditFixture(t, true)
			ent.StartsAt = time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.FixedZone("offset", 330*60))
			ent.Cycle = service.CyclePolicy{Mode: "anniversary", Day: 28, Days: 19, Anchor: ent.StartsAt, Timezone: "Asia/Shanghai"}
			if explicit {
				zero, integerZero, routes := int64(0), 0, []string{}
				ent.QuotaOverride, ent.EntryRateBPSOverride = &zero, &zero
				ent.OnlineIPLimitOverride, ent.ConnectionLimitOverride = &integerZero, &integerZero
				ent.RouteIDsOverride = &routes
			}
			if err := s.PutEntitlement(ent); err != nil {
				t.Fatal(err)
			}
			opened, err := s.EntitlementPolicyEditContext("subject", now)
			if err != nil || opened.Effective == nil {
				t.Fatalf("context: %+v %v", opened, err)
			}
			got := opened.Record.Entitlement
			if !got.StartsAt.Equal(ent.StartsAt) || got.StartsAt.Nanosecond() != 123456789 || got.Cycle.Day != 28 || got.Cycle.Days != 19 || got.Cycle.Timezone != "Asia/Shanghai" || !reflect.DeepEqual(got.RouteIDsOverride, ent.RouteIDsOverride) || !reflect.DeepEqual(got.QuotaOverride, ent.QuotaOverride) || !reflect.DeepEqual(got.OnlineIPLimitOverride, ent.OnlineIPLimitOverride) {
				t.Fatalf("context erased inactive/nullable values: %+v", got)
			}
			got.Paused = true
			preview := applyEntitlementEdit(t, s, *opened.Record, opened.Precondition, now)
			if preview.Resource.Before.Entitlement.Paused || !preview.Resource.After.Entitlement.Paused || preview.Resource.After.Entitlement.Cycle.Day != 28 || preview.Resource.After.Entitlement.StartsAt.Nanosecond() != 123456789 {
				t.Fatalf("typed resource changed unedited values: %+v", preview.Resource)
			}
		})
	}
	s, _, now := entitlementEditFixture(t, false)
	if err := s.Put("entitlements", "subject", map[string]any{"userId": "subject", "cycle": map[string]any{"mode": "none"}}); err != nil {
		t.Fatal(err)
	}
	partial, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil || !partial.Precondition.Exists || partial.Record.Entitlement.Cycle.Timezone != "" || partial.Effective == nil || partial.Effective.Entitlement.Cycle.Timezone != "UTC+8" {
		t.Fatalf("partial stored row was replaced by effective default seed: %+v %v", partial, err)
	}
}

func TestEntitlementEditBaselinePrecedesStaleReferencesAndEffectiveEnrichment(t *testing.T) {
	s, ent, now := entitlementEditFixture(t, true)
	opened, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	ent.ServiceID = ""
	if err := s.PutEntitlement(ent); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("services", "plan", map[string]any{"id": "plan", "name": 42}); err != nil {
		t.Fatal(err)
	}
	opened.Record.Entitlement.Paused = true
	if preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || preview.Revision != "" {
		t.Fatalf("old reference/effective read obscured baseline conflict: %+v %v", preview, err)
	}
	if _, err := s.EntitlementPolicyEditContext("subject", now); err == nil {
		t.Fatal("direct coherent read swallowed broken effective data")
	}
	if err := s.Remove("services", "plan"); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	fresh.Record.Entitlement.ServiceID = "plan"
	if preview, err := s.PreviewPolicyEdit(*fresh.Record, fresh.Precondition, now); err == nil || errors.Is(err, store.ErrPolicyEditBaselineChanged) || preview.Revision != "" {
		t.Fatalf("current token bypassed candidate reference validation: %+v %v", preview, err)
	}
}

func TestEntitlementEditContentIdentityDoesNotWeakenBroadApplyCAS(t *testing.T) {
	s, ent, now := entitlementEditFixture(t, true)
	opened, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	later, err := s.EntitlementPolicyEditContext("subject", now.AddDate(2, 0, 1))
	if err != nil || later.Precondition != opened.Precondition || opened.Effective.Status != "active" || later.Effective.Status != "expired" {
		t.Fatalf("effective read time changed row baseline or was ignored: %+v %v", later, err)
	}
	if err := s.PutEntitlement(ent); err != nil {
		t.Fatal(err)
	}
	equivalent, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil || equivalent.Precondition != opened.Precondition {
		t.Fatalf("reencryption changed content identity: %+v %v", equivalent, err)
	}
	if err := s.Remove("entitlements", "subject"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("deleted row became recreation: %v", err)
	}
	if err := s.PutEntitlement(ent); err != nil {
		t.Fatal(err)
	}
	if err := s.PutUser(domain.User{ID: "other", Name: "Subject", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	opened.Record.Entitlement.Paused = true
	preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatalf("same content recreation/unrelated pre-preview row rejected: %v", err)
	}
	if err := s.PutUser(domain.User{ID: "other", Name: "Renamed", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, preview.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("broad snapshot was weakened: %v", err)
	}
	preview, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	changed := *opened.Record.Entitlement
	changed.Cycle.Day = 20
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Entitlement: &changed}, preview.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("changed hidden candidate reused ticket: %v", err)
	}
	other := *opened.Record.Entitlement
	other.UserID = "other"
	if _, err := s.PreviewPolicyEdit(service.PolicyChange{Entitlement: &other}, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("same-name subject accepted another ID token: %v", err)
	}
}

func TestEntitlementEditContextRejectsMissingSubjectAndUnsupportedRows(t *testing.T) {
	s, _, now := entitlementEditFixture(t, false)
	if _, err := s.EntitlementPolicyEditContext("missing-user", now); err != store.ErrNotFound {
		t.Fatalf("missing subject was synthesized: %v", err)
	}
	for _, row := range []map[string]any{
		{"userId": "other", "cycle": map[string]any{"mode": "none"}},
		{"userId": "subject", "futureOverride": true},
		{"userId": "subject", "quotaOverride": "not a number"},
	} {
		if err := s.Put("entitlements", "subject", row); err != nil {
			t.Fatal(err)
		}
		if _, err := s.EntitlementPolicyEditContext("subject", now); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) {
			t.Fatalf("unsupported saved shape discarded: %+v %v", row, err)
		}
	}
}

func TestEntitlementEditKeepsLegacyResponseShapeAndTransportOutOfStorage(t *testing.T) {
	s, ent, now := entitlementEditFixture(t, true)
	opened, err := s.EntitlementPolicyEditContext("subject", now)
	if err != nil {
		t.Fatal(err)
	}
	ent.Paused = true
	change := service.PolicyChange{Entitlement: &ent}
	legacy, err := s.PreviewPolicyChange(change, now)
	if err != nil || legacy.Resource != nil || legacy.Guard != "" {
		t.Fatalf("legacy UI received new resource variant: %+v %v", legacy, err)
	}
	guarded, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || guarded.Resource == nil || guarded.Guard != "opened-record" {
		t.Fatalf("guarded response missing resource: %+v %v", guarded, err)
	}
	applied, err := s.ApplyPolicyChange(change, guarded.Revision, now)
	if err != nil || applied.Resource != nil || applied.Guard != "" {
		t.Fatalf("unchanged apply response gained unsupported variant: %+v %v", applied, err)
	}
	var raw map[string]any
	if err := s.Get("entitlements", "subject", &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"effective", "precondition", "revision", "guard", "target", "resource", "references"} {
		if _, exists := raw[key]; exists {
			t.Fatalf("transport metadata persisted: %s", key)
		}
	}
	// An intentional legacy replacement can still repair an old unknown field;
	// it must not be forced through the guarded editor's stricter context reader.
	raw["futureOverride"] = true
	if err := s.Put("entitlements", "subject", raw); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EntitlementPolicyEditContext("subject", now); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) {
		t.Fatalf("guarded context discarded unknown data: %v", err)
	}
	legacy, err = s.PreviewPolicyChange(change, now)
	if err != nil || legacy.Resource != nil {
		t.Fatalf("legacy repair gained guarded decoding: %+v %v", legacy, err)
	}
	if _, err := s.ApplyPolicyChange(change, legacy.Revision, now); err != nil {
		t.Fatalf("intentional legacy replacement was blocked: %v", err)
	}
}

func TestEntitlementEditStillBlocksIssuedBudgetQuotaAndCalendarChanges(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	if admitted, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "entitlement-edit"), now); err != nil || !admitted.Allowed {
		t.Fatalf("admission: %+v %v", admitted, err)
	}
	opened, err := s.EntitlementPolicyEditContext("account", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"quota", "calendar"} {
		t.Run(name, func(t *testing.T) {
			candidate := *opened.Record.Entitlement
			if name == "quota" {
				quota := int64(50)
				candidate.QuotaOverride = &quota
			} else {
				candidate.Cycle = service.CyclePolicy{Mode: "fixed-days", Days: 7, Anchor: now, Timezone: "UTC+8"}
			}
			change := service.PolicyChange{Entitlement: &candidate}
			preview, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
			if err != nil || len(preview.Blockers) == 0 {
				t.Fatalf("issued budget bypassed: %+v %v", preview, err)
			}
			if _, err := s.ApplyPolicyChange(change, preview.Revision, now); err == nil {
				t.Fatal("blocked candidate applied")
			}
		})
	}
	var saved service.Entitlement
	if err := s.Get("entitlements", "account", &saved); err != nil || !reflect.DeepEqual(saved, *opened.Record.Entitlement) {
		t.Fatalf("blocked edit changed saved calendar/limits: %+v %v", saved, err)
	}
}
