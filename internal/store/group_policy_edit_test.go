package store_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Display labels are observed at a read/preview, not the group's historical
// save time. They do not alter opening-record equivalence or apply CAS.
func TestGroupEditReferenceLabelsFreezeReadTimeAndKeepExistingApplySnapshot(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantUsers := []service.PolicyReferenceLabel{{ID: "u1", Name: "Same display name"}}
	if opened.References == nil || !reflect.DeepEqual(opened.References.Users, wantUsers) || len(opened.References.Services) != 1 || opened.References.Services[0].ID != "plan" {
		t.Fatalf("opening labels absent or include unrelated members: %+v", opened.References)
	}
	var user domain.User
	var plan service.Plan
	var entitlement service.Entitlement
	if err := s.Get("users", "u1", &user); err != nil {
		t.Fatal(err)
	}
	if err := s.Get("services", "plan", &plan); err != nil {
		t.Fatal(err)
	}
	if err := s.Get("entitlements", "u1", &entitlement); err != nil {
		t.Fatal(err)
	}
	user.Name = "Alice now"
	plan.Name = "Plan now"
	if err := s.PutUser(user); err != nil {
		t.Fatal(err)
	}
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || fresh.Precondition != opened.Precondition || !reflect.DeepEqual(opened.References.Users, wantUsers) || fresh.References == nil || len(fresh.References.Users) != 1 || fresh.References.Users[0].Name != "Alice now" {
		t.Fatalf("labels changed group baseline or old context: %+v %v", fresh, err)
	}
	opened.Record.Group.Name = "Rename only"
	preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.References == nil || len(preview.Affected) != 0 {
		t.Fatalf("zero-impact resource lost display context: %+v %v", preview, err)
	}
	want := service.PolicyReferenceLabels{Users: []service.PolicyReferenceLabel{{ID: "u1", Name: "Alice now"}}, Services: []service.PolicyReferenceLabel{{ID: "plan", Name: "Plan now"}}}
	if !reflect.DeepEqual(preview.Resource.References.Before, want) || !reflect.DeepEqual(preview.Resource.References.After, want) {
		t.Fatalf("preview used opening/current-catalog mixture: %+v", preview.Resource.References)
	}
	user.Name = "Alice after preview"
	if err := s.PutUser(user); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, preview.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("user label change bypassed existing snapshot: %v", err)
	}
	preview, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	plan.Name = "Plan after preview"
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, preview.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("plan label change bypassed existing snapshot: %v", err)
	}
	preview, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := s.Get("user-groups", group.ID, &saved); err != nil || len(saved) != 5 || saved["references"] != nil {
		t.Fatalf("display metadata persisted: %+v %v", saved, err)
	}
	var afterUser domain.User
	var afterEntitlement service.Entitlement
	if err := s.Get("users", "u1", &afterUser); err != nil || afterUser != user {
		t.Fatalf("display review changed user/usage: %+v %v", afterUser, err)
	}
	if err := s.Get("entitlements", "u1", &afterEntitlement); err != nil || !reflect.DeepEqual(afterEntitlement, entitlement) {
		t.Fatalf("display review changed calendar: %+v %v", afterEntitlement, err)
	}
}

func TestGroupEditReferenceLabelsStaySparseAndUseExactReferenceIdentity(t *testing.T) {
	s, group, now := groupEditFixture(t)
	group.MemberIDs = []string{"u2", "u1", "u2"}
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	var plan service.Plan
	if err := s.Get("services", "plan", &plan); err != nil {
		t.Fatal(err)
	}
	plan.ID = "same-name-plan"
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantUsers := []service.PolicyReferenceLabel{{ID: "u1", Name: "Same display name"}, {ID: "u2", Name: "Same display name"}}
	if opened.References == nil || !reflect.DeepEqual(opened.References.Users, wantUsers) || !reflect.DeepEqual(opened.Record.Group.MemberIDs, []string{"u2", "u1", "u2"}) {
		t.Fatalf("name collapsed IDs or display changed raw members: %+v", opened)
	}
	opened.Record.Group.MemberIDs = []string{"u2"}
	opened.Record.Group.ServiceID = "same-name-plan"
	preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.References == nil {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	refs := preview.Resource.References
	if !reflect.DeepEqual(refs.Before.Users, wantUsers) || !reflect.DeepEqual(refs.After.Users, wantUsers[1:]) || len(refs.Before.Services) != 1 || len(refs.After.Services) != 1 || refs.Before.Services[0].ID != "plan" || refs.After.Services[0].ID != "same-name-plan" || refs.Before.Services[0].Name != refs.After.Services[0].Name {
		t.Fatalf("labels crossed identity or leaked unrelated references: %+v", refs)
	}
	if err := s.Remove("users", "u1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("services", "plan"); err != nil {
		t.Fatal(err)
	}
	missing, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || missing.References == nil || !reflect.DeepEqual(missing.References.Users, wantUsers[1:]) || len(missing.References.Services) != 0 || missing.Record.Group.ServiceID != "plan" {
		t.Fatalf("missing labels fabricated identity or removed references: %+v %v", missing, err)
	}
	preview, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.References == nil || len(preview.Resource.References.Before.Services) != 0 || !reflect.DeepEqual(preview.Resource.References.Before.Users, wantUsers[1:]) {
		t.Fatalf("removed missing reference labels blocked valid replacement: %+v %v", preview, err)
	}
	absent, err := s.GroupPolicyEditContext("absent-group")
	if err != nil || absent.References == nil || absent.References.Users == nil || absent.References.Services == nil || len(absent.References.Users) != 0 || len(absent.References.Services) != 0 {
		t.Fatalf("absence should have explicit empty display collections: %+v %v", absent, err)
	}
	serviceContext, err := s.ServicePolicyEditContext("same-name-plan")
	if err != nil || serviceContext.References != nil {
		t.Fatalf("service display scope changed: %+v %v", serviceContext, err)
	}
}

func TestGroupEditReferenceLabelsNeverUseUnusableNamesOrWrongEmbeddedIdentity(t *testing.T) {
	for _, test := range []struct {
		name   string
		record map[string]any
	}{
		{"blank", map[string]any{"id": "u1", "name": "  "}},
		{"wrong identity", map[string]any{"id": "other", "name": "Misleading"}},
		{"non-string name", map[string]any{"id": "u1", "name": 42}},
		{"missing name", map[string]any{"id": "u1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, group, _ := groupEditFixture(t)
			if err := s.Put("users", "u1", test.record); err != nil {
				t.Fatal(err)
			}
			context, err := s.GroupPolicyEditContext(group.ID)
			if err != nil || context.References == nil || len(context.References.Users) != 0 || !reflect.DeepEqual(context.Record.Group.MemberIDs, []string{"u1"}) {
				t.Fatalf("unusable label was attached or reference removed: %+v %v", context, err)
			}
		})
	}
}

func TestGroupEditBaselinePrecedesMalformedReferencePolicyValidation(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	group.Name = "Concurrent rename"
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put("users", "u1", map[string]any{"id": "u1", "name": 42}); err != nil {
		t.Fatal(err)
	}
	// Remove the malformed old reference from each candidate. Display projection
	// can omit its unusable name, but must not weaken the authoritative snapshot's
	// full User decoding. The stale baseline still wins before either step.
	opened.Record.Group.MemberIDs = []string{}
	fresh.Record.Group.MemberIDs = []string{}
	if preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || preview.Revision != "" {
		t.Fatalf("label lookup obscured actionable baseline conflict: %+v %v", preview, err)
	}
	var decodeError *json.UnmarshalTypeError
	if preview, err := s.PreviewPolicyEdit(*fresh.Record, fresh.Precondition, now); !errors.As(err, &decodeError) || preview.Revision != "" {
		t.Fatalf("display fallback bypassed authoritative policy validation: %+v %v", preview, err)
	}
	if context, err := s.GroupPolicyEditContext(group.ID); err != nil || context.References == nil || len(context.References.Users) != 0 || !reflect.DeepEqual(context.Record.Group.MemberIDs, []string{"u1"}) {
		t.Fatalf("unusable display name did not preserve exact-ID fallback: %+v %v", context, err)
	}
	var saved service.Group
	if err := s.Get("user-groups", group.ID, &saved); err != nil || !reflect.DeepEqual(saved, group) {
		t.Fatalf("failed enrichment changed membership: %+v %v", saved, err)
	}
}

func TestGroupEditUnusableOldLabelDoesNotBlockZeroUserLegacyRepair(t *testing.T) {
	s, plan, now := policyEditFixture(t)
	brokenPlan := map[string]any{"id": "broken-plan", "name": 42}
	if err := s.Put("services", "broken-plan", brokenPlan); err != nil {
		t.Fatal(err)
	}
	group := service.Group{ID: "repair-group", Name: "Empty group", ServiceID: "broken-plan", MemberIDs: []string{}}
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || opened.References == nil || len(opened.References.Services) != 0 || opened.Record.Group.ServiceID != "broken-plan" {
		t.Fatalf("old unusable label blocked opening or invented identity: %+v %v", opened, err)
	}
	if preview, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); err == nil || errors.Is(err, store.ErrPolicyEditBaselineChanged) || preview.Revision != "" {
		t.Fatalf("display fallback made an invalid candidate service valid: %+v %v", preview, err)
	}
	replacement := group
	replacement.ServiceID = plan.ID
	change := service.PolicyChange{Group: &replacement}
	legacy, err := s.PreviewPolicyChange(change, now)
	if err != nil || legacy.Resource == nil || legacy.Resource.References == nil || legacy.Guard != "" || len(legacy.Affected) != 0 {
		t.Fatalf("optional display metadata blocked a valid legacy repair: %+v %v", legacy, err)
	}
	if len(legacy.Resource.References.Before.Services) != 0 || !reflect.DeepEqual(legacy.Resource.References.After.Services, []service.PolicyReferenceLabel{{ID: plan.ID, Name: plan.Name}}) {
		t.Fatalf("repair labels did not preserve exact reference meaning: %+v", legacy.Resource.References)
	}
	guarded, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || guarded.Guard != "opened-record" || !reflect.DeepEqual(guarded.Resource, legacy.Resource) {
		t.Fatalf("guarded valid repair differs from authoritative legacy outcome: %+v %v", guarded, err)
	}
	if _, err := s.ApplyPolicyChange(change, legacy.Revision, now); err != nil {
		t.Fatalf("label-free legacy apply could not repair group reference: %v", err)
	}
	var saved service.Group
	if err := s.Get("user-groups", group.ID, &saved); err != nil || !reflect.DeepEqual(saved, replacement) {
		t.Fatalf("repair did not persist exact replacement: %+v %v", saved, err)
	}
	var unchanged map[string]any
	if err := s.Get("services", "broken-plan", &unchanged); err != nil || unchanged["name"] != float64(42) {
		t.Fatalf("display projection changed referenced policy data: %+v %v", unchanged, err)
	}
	if users, err := s.List("users"); err != nil || len(users) != 0 {
		t.Fatalf("zero-user tracer unexpectedly materialized users: %v %v", users, err)
	}
}

func groupEditFixture(t *testing.T) (*store.Store, service.Group, time.Time) {
	t.Helper()
	s, plan, now := policyEditFixture(t)
	for _, id := range []string{"u1", "u2"} {
		if err := s.PutUser(domain.User{ID: id, Name: "Same display name", Enabled: true}); err != nil {
			t.Fatal(err)
		}
		if err := s.PutEntitlement(service.Entitlement{UserID: id, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
			t.Fatal(err)
		}
	}
	group := service.Group{ID: "group", Name: "Members", ServiceID: plan.ID, Priority: 10, MemberIDs: []string{"u1"}}
	preview, err := s.PreviewPolicyChange(service.PolicyChange{Group: &group}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Group: &group}, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	return s, group, now
}

// Public read/preview/apply tracer, authored before guarded group implementation.
// No runtime RED/GREEN claim: the separate old-API characterization establishes
// the old lost-update behavior without relying on a missing new endpoint.
func TestGroupEditRejectsOpeningRenameAfterAnotherEditorChangesMembers(t *testing.T) {
	s, group, now := groupEditFixture(t)
	a, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	b.Record.Group.MemberIDs = []string{"u1", "u2"}
	preview, err := s.PreviewPolicyEdit(*b.Record, b.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*b.Record, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	a.Record.Group.Name = "Renamed"
	rejected, err := s.PreviewPolicyEdit(*a.Record, a.Precondition, now)
	if !errors.Is(err, store.ErrPolicyEditBaselineChanged) || rejected.Revision != "" {
		t.Fatalf("stale full group got ticket: %+v %v", rejected, err)
	}
	fresh, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || fresh.Record.Group.Name != "Members" || !reflect.DeepEqual(fresh.Record.Group.MemberIDs, []string{"u1", "u2"}) {
		t.Fatalf("stale draft leaked: %+v %v", fresh, err)
	}
	fresh.Record.Group.Name = "Renamed"
	preview, err = s.PreviewPolicyEdit(*fresh.Record, fresh.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Guard != "opened-record" || preview.Resource == nil || preview.Resource.Target != (service.PolicyResourceTarget{Kind: "group", ID: "group"}) || preview.Resource.Before.Group.Name != "Members" || preview.Resource.After.Group.Name != "Renamed" || !reflect.DeepEqual(preview.Resource.After.Group.MemberIDs, []string{"u1", "u2"}) || len(preview.Affected) != 0 {
		t.Fatalf("missing coherent zero-impact group review: %+v", preview)
	}
	if _, err := s.ApplyPolicyChange(*fresh.Record, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	final, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || final.Record.Group.Name != "Renamed" || !reflect.DeepEqual(final.Record.Group.MemberIDs, []string{"u1", "u2"}) {
		t.Fatalf("explicit reconciliation lost membership: %+v %v", final, err)
	}
}

func TestGroupEditCreationRequiresAbsenceAndExactKindIdentity(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext("new-group")
	if err != nil || opened.Record != nil || opened.Precondition.Exists || opened.Precondition.Revision == "" {
		t.Fatalf("missing explicit absence: %+v %v", opened, err)
	}
	group.ID = "new-group"
	group.MemberIDs = []string{}
	change := service.PolicyChange{Group: &group}
	preview, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || preview.Resource == nil || preview.Resource.Before != nil || preview.Resource.After.Group.ID != "new-group" || len(preview.Affected) != 0 {
		t.Fatalf("creation resource missing: %+v %v", preview, err)
	}
	absent, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || absent.Record != nil {
		t.Fatalf("preview materialized group: %+v %v", absent, err)
	}
	if _, err := s.ApplyPolicyChange(change, preview.Revision, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(change, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("absent token became upsert: %v", err)
	}
	group.ID = "another-group"
	if _, err := s.PreviewPolicyEdit(change, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("absence transplanted across ID: %v", err)
	}
	serviceAbsent, err := s.ServicePolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(change, serviceAbsent.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("service token transplanted across kind: %v", err)
	}
}

func TestGroupEditBaselinePrecedesStaleMemberReferenceValidation(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	group.MemberIDs = []string{"u2"}
	p, err := s.PreviewPolicyChange(service.PolicyChange{Group: &group}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Group: &group}, p.Revision, now); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("users", "u1"); err != nil {
		t.Fatal(err)
	}
	opened.Record.Group.Name = "Renamed"
	if p, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) || p.Revision != "" {
		t.Fatalf("old missing member obscured baseline: %+v %v", p, err)
	}
	fresh, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	fresh.Record.Group.MemberIDs = []string{"u1"}
	if _, err := s.PreviewPolicyEdit(*fresh.Record, fresh.Precondition, now); err == nil || errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("valid baseline bypassed member check: %v", err)
	}
}

func TestGroupEditTargetBaselineLeavesBroadApplyAndExactChangeCASIntact(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	other := group
	other.ID = "other"
	other.MemberIDs = []string{}
	if err := s.Put("user-groups", other.ID, other); err != nil {
		t.Fatal(err)
	}
	opened.Record.Group.Name = "Renamed"
	p, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatalf("unrelated pre-preview record rejected: %v", err)
	}
	other.Name = "New other name"
	if err := s.Put("user-groups", other.ID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, p.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("broad apply snapshot weakened: %v", err)
	}
	p, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	changed := *opened.Record.Group
	changed.Priority++
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Group: &changed}, p.Revision, now); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("unreviewed priority reused ticket: %v", err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, p.Revision, now); err != nil {
		t.Fatal(err)
	}
}

func TestGroupEditPreservesRawMemberPresenceAndReviewsNormalizedCandidate(t *testing.T) {
	for _, members := range [][]string{nil, {}, {"u2", "u1", "u2"}} {
		t.Run(fmt.Sprintf("members-%v-nil-%t", members, members == nil), func(t *testing.T) {
			s, group, now := groupEditFixture(t)
			group.MemberIDs = members
			group.Priority = -7
			if err := s.Put("user-groups", group.ID, group); err != nil {
				t.Fatal(err)
			}
			opened, err := s.GroupPolicyEditContext(group.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(opened.Record.Group.MemberIDs, members) || opened.Record.Group.Priority != -7 {
				t.Fatalf("opening lost typed record: %+v", opened)
			}
			opened.Record.Group.Name = "Rename only"
			p, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{}
			if len(members) > 0 {
				want = []string{"u1", "u2"}
			}
			if p.Resource == nil || p.Resource.Before == nil || !reflect.DeepEqual(p.Resource.Before.Group.MemberIDs, members) || !reflect.DeepEqual(p.Resource.After.Group.MemberIDs, want) || p.Resource.After.Group.Priority != -7 {
				t.Fatalf("raw before/normalized after mismatch: %+v", p.Resource)
			}
		})
	}
}

func TestGroupEditContentEquivalenceDoesNotClaimIncarnationIdentity(t *testing.T) {
	s, group, now := groupEditFixture(t)
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	same, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || same.Precondition != opened.Precondition {
		t.Fatalf("equivalent rewrite changed token: %+v %v", same, err)
	}
	if err := s.Remove("user-groups", group.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("delete became implicit create: %v", err)
	}
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); err != nil {
		t.Fatalf("same-content recreate must be equivalent: %v", err)
	}
	group.ID = "same-name"
	if err := s.Put("user-groups", group.ID, group); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewPolicyEdit(service.PolicyChange{Group: &group}, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditBaselineChanged) {
		t.Fatalf("same display name crossed target: %v", err)
	}
}

func TestGroupEditRejectsUnsupportedStoredFieldsAndWrongEmbeddedIdentity(t *testing.T) {
	for _, record := range []map[string]any{
		{"id": "group", "name": "Members", "serviceId": "plan", "priority": 1, "memberIds": []string{"u1"}, "futureRule": true},
		{"id": "wrong-id", "name": "Members", "serviceId": "plan", "priority": 1, "memberIds": []string{"u1"}},
	} {
		t.Run(record["id"].(string), func(t *testing.T) {
			s, group, now := groupEditFixture(t)
			opened, err := s.GroupPolicyEditContext(group.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Put("user-groups", group.ID, record); err != nil {
				t.Fatal(err)
			}
			if _, err := s.GroupPolicyEditContext(group.ID); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) {
				t.Fatalf("unsupported saved shape reached editor: %v", err)
			}
			if p, err := s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now); !errors.Is(err, store.ErrPolicyEditUnsupportedRecord) || p.Revision != "" {
				t.Fatalf("unsupported data overwritten: %+v %v", p, err)
			}
			var retained map[string]any
			if err := s.Get("user-groups", group.ID, &retained); err != nil || retained["id"] != record["id"] || retained["futureRule"] != record["futureRule"] {
				t.Fatalf("saved data altered: %+v %v", retained, err)
			}
		})
	}
}

func TestGroupEditGuardKeepsFirstCalendarAnchorAndPreviewNonPersistence(t *testing.T) {
	s, _, now := groupEditFixture(t)
	if err := s.PutUser(domain.User{ID: "new-user", Name: "New user", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	opened, err := s.GroupPolicyEditContext("first-group")
	if err != nil {
		t.Fatal(err)
	}
	group := service.Group{ID: "first-group", Name: "First", ServiceID: "plan", MemberIDs: []string{"new-user"}}
	change := service.PolicyChange{Group: &group}
	p, err := s.PreviewPolicyEdit(change, opened.Precondition, now)
	if err != nil || len(p.Affected) != 1 || p.Affected[0].After.Entitlement.Cycle.Day != 1 || !p.Affected[0].After.Entitlement.Cycle.Anchor.Equal(now) {
		t.Fatalf("first-assignment review: %+v %v", p, err)
	}
	var ent service.Entitlement
	if err := s.Get("entitlements", "new-user", &ent); err != store.ErrNotFound {
		t.Fatalf("preview created entitlement: %+v %v", ent, err)
	}
	if _, err := s.ApplyPolicyChange(change, p.Revision, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Get("entitlements", "new-user", &ent); err != nil || !ent.Cycle.Anchor.Equal(now) || !ent.StartsAt.Equal(now) {
		t.Fatalf("apply changed reviewed calendar: %+v %v", ent, err)
	}
}

func TestGroupEditGuardPreservesIssuedBudgetBlocker(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	if err := s.PutEntitlement(service.Entitlement{UserID: "account", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
		t.Fatal(err)
	}
	group := service.Group{ID: "guarded-budget", Name: "Members", ServiceID: "plan", MemberIDs: []string{"account"}}
	absent, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.PreviewPolicyEdit(service.PolicyChange{Group: &group}, absent.Precondition, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPolicyChange(service.PolicyChange{Group: &group}, p.Revision, now); err != nil {
		t.Fatal(err)
	}
	if err := s.PutServicePlan(service.Plan{ID: "limited", Name: "Limited", QuotaBytes: 100, RouteIDs: []string{"route"}, EntryRateBPS: 512}); err != nil {
		t.Fatal(err)
	}
	if admitted, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "group-guarded-edit"), now); err != nil || !admitted.Allowed {
		t.Fatalf("admission: %+v %v", admitted, err)
	}
	opened, err := s.GroupPolicyEditContext(group.ID)
	if err != nil {
		t.Fatal(err)
	}
	opened.Record.Group.ServiceID = "limited"
	p, err = s.PreviewPolicyEdit(*opened.Record, opened.Precondition, now)
	if err != nil || len(p.Blockers) == 0 {
		t.Fatalf("guarded group bypassed budget: %+v %v", p, err)
	}
	if _, err := s.ApplyPolicyChange(*opened.Record, p.Revision, now); err == nil {
		t.Fatal("blocked group applied")
	}
	saved, err := s.GroupPolicyEditContext(group.ID)
	if err != nil || saved.Record.Group.ServiceID != "plan" {
		t.Fatalf("blocked group leaked: %+v %v", saved, err)
	}
}
