package store_test

import (
	"errors"
	"reflect"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func futureAnchorEntitlement(now time.Time, mode string, quota int64) service.Entitlement {
	return service.Entitlement{UserID: "account", ServiceID: "plan", StartsAt: now.Add(-time.Hour), QuotaOverride: &quota, Cycle: service.CyclePolicy{Mode: mode, Day: 1, Days: 30, Anchor: now.Add(time.Minute), Timezone: "UTC+8"}}
}

func TestFutureAnchorAdmissionSafetyHold(t *testing.T) {
	for _, mode := range []string{"monthly", "anniversary", "fixed-days", "none"} {
		for _, scenario := range []string{"future-finite", "anchor-equality", "future-unlimited"} {
			t.Run(mode+"/"+scenario, func(t *testing.T) {
				s, _, _, scope, now := admissionFixture(t)
				quota := int64(100)
				if scenario == "future-unlimited" {
					quota = 0
				}
				ent := futureAnchorEntitlement(now, mode, quota)
				if scenario == "anchor-equality" {
					ent.Cycle.Anchor = now
				}
				if err := s.PutEntitlement(ent); err != nil {
					t.Fatal(err)
				}
				got, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "first"), now)
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "future-finite" {
					if got.Allowed || got.Reason != "accounting-pending" || got.ByteBudget != nil {
						t.Fatalf("unsafe grant: %+v", got)
					}
					var budget any
					if err := s.Get("admission-budgets", got.LeaseID, &budget); !errors.Is(err, store.ErrNotFound) {
						t.Fatalf("denial created budget: %v", err)
					}
				} else if !got.Allowed || (quota > 0 && (got.ByteBudget == nil || *got.ByteBudget != 100)) || (quota == 0 && got.ByteBudget != nil) {
					t.Fatalf("ordinary policy changed: %+v", got)
				}
				var saved service.Entitlement
				if err := s.Get("entitlements", "account", &saved); err != nil || !reflect.DeepEqual(ent, saved) {
					t.Fatalf("policy rewritten: %+v %v", saved, err)
				}
			})
		}
	}
}

func TestFutureAnchorLegacyZeroAnchorRemainsUsable(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	got, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "first"), now)
	if err != nil || !got.Allowed || got.ByteBudget == nil || *got.ByteBudget != 100 {
		t.Fatalf("legacy no-reset quota changed: %+v %v", got, err)
	}
}

func TestFutureAnchorExistingBudgetSettlesBeforeSafetyHold(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	request := admissionRequest("entry1", "192.0.2.1", "first")
	first, err := s.AcquireAdmission(scope, request, now)
	if err != nil || !first.Allowed {
		t.Fatalf("fixture grant: %+v %v", first, err)
	}
	// Seed persisted pre-fix state through the storage seam, not a permitted
	// live policy edit: ordinary policy writes fence outstanding budgets.
	ent := futureAnchorEntitlement(now, "monthly", 100)
	if err := s.Put("entitlements", "account", ent); err != nil {
		t.Fatal(err)
	}
	var original map[string]any
	if err := s.Get("admission-budgets", first.LeaseID, &original); err != nil {
		t.Fatal(err)
	}
	// Match the already-issued future-window budget that the old implementation
	// could persist. Never use this raw fixture write as a production migration.
	original["cycleStart"] = ent.Cycle.Anchor.Format(time.RFC3339Nano)
	original["policyEnd"] = ent.Cycle.Anchor.Format(time.RFC3339Nano)
	if err := s.Put("admission-budgets", first.LeaseID, original); err != nil {
		t.Fatal(err)
	}
	request.AdmittedBytes = 40
	for i := 1; i <= 2; i++ {
		got, err := s.AcquireAdmission(scope, request, now.Add(time.Duration(i)*time.Second))
		if err != nil || got.Allowed || got.Reason != "accounting-pending" {
			t.Fatalf("renewal: %+v %v", got, err)
		}
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 40 || usage.WeightedBytes != 40 {
		t.Fatalf("settlement lost or duplicated: %+v %v", usage, err)
	}
	var held map[string]any
	if err := s.Get("admission-budgets", first.LeaseID, &held); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"grantedRaw", "expiresAt", "cycleStart"} {
		if !reflect.DeepEqual(original[key], held[key]) {
			t.Fatalf("hold changed issued %s", key)
		}
	}
	request.AdmittedBytes, request.Final = 100, true
	for i := 3; i <= 4; i++ {
		got, err := s.AcquireAdmission(scope, request, now.Add(time.Duration(i)*time.Second))
		if err != nil || got.Allowed || got.Reason != "presence-closed" {
			t.Fatalf("final: %+v %v", got, err)
		}
	}
	ledgerBefore, err := s.List("ledger")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "second"), now.Add(5*time.Second))
	if err != nil || got.Allowed || got.Reason != "accounting-pending" {
		t.Fatalf("settlement refunded quota: %+v %v", got, err)
	}
	ledgerAfter, err := s.List("ledger")
	if err != nil || !reflect.DeepEqual(ledgerBefore, ledgerAfter) {
		t.Fatalf("hold rewrote canonical ledger: %v", err)
	}
	usage, err = s.Usage("account", time.Time{}, ent.Cycle.Anchor)
	if err != nil || usage.RawBytes != 100 || usage.WeightedBytes != 100 {
		t.Fatalf("pre-anchor history rewritten: %+v %v", usage, err)
	}
}

func TestFutureAnchorServicePolicyFenceSharesSafetyHold(t *testing.T) {
	for _, mode := range []string{"monthly", "anniversary", "fixed-days", "none"} {
		for _, quota := range []int64{0, 100} {
			name := "/unlimited"
			if quota > 0 {
				name = "/finite"
			}
			t.Run(mode+name, func(t *testing.T) {
				s, _, _, _, now := admissionFixture(t)
				ent := futureAnchorEntitlement(now, mode, quota)
				if err := s.PutEntitlement(ent); err != nil {
					t.Fatal(err)
				}
				policy, err := s.EffectivePolicy("account", now)
				if err != nil {
					t.Fatal(err)
				}
				if policy.Status != "active" {
					t.Fatalf("fixture must retain independent validity: %+v", policy)
				}
				fence := store.ServicePolicyFence{Checks: []store.ServicePolicyCheck{{Policy: policy, RouteIDs: []string{"route"}}}, ValidUntil: now.Add(30 * time.Second)}
				err = s.CompareServicePolicyAndPutRecords(fence, nil, nil, []store.RecordWrite{{Kind: "service-grants", ID: "one", Value: "granted"}})
				if quota == 0 {
					if err != nil {
						t.Fatal(err)
					}
					return
				}
				if !errors.Is(err, store.ErrConflict) {
					t.Fatalf("unsafe service grant: %v", err)
				}
				var grant any
				if err = s.Get("service-grants", "one", &grant); !errors.Is(err, store.ErrNotFound) {
					t.Fatalf("partial write: %v", err)
				}
			})
		}
	}
}

func TestFutureAnchorSafetyHoldReleasesWithoutPolicyRewrite(t *testing.T) {
	for _, mode := range []string{"monthly", "anniversary", "fixed-days", "none"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			ent := futureAnchorEntitlement(now, mode, 100)
			if err := s.PutEntitlement(ent); err != nil {
				t.Fatal(err)
			}
			request := admissionRequest("entry1", "192.0.2.1", "waiting")
			before, err := s.AcquireAdmission(scope, request, now)
			if err != nil || before.Allowed || before.Reason != "accounting-pending" {
				t.Fatalf("expected hold: %+v %v", before, err)
			}
			after, err := s.AcquireAdmission(scope, request, ent.Cycle.Anchor)
			if err != nil || !after.Allowed || after.ByteBudget == nil || *after.ByteBudget != 100 {
				t.Fatalf("hold did not release at anchor: %+v %v", after, err)
			}
			var saved service.Entitlement
			if err := s.Get("entitlements", "account", &saved); err != nil || !reflect.DeepEqual(ent, saved) {
				t.Fatalf("hold release rewrote policy: %+v %v", saved, err)
			}
			usage, err := s.Usage("account", time.Time{}, time.Time{})
			if err != nil || usage.RawBytes != 0 || usage.WeightedBytes != 0 {
				t.Fatalf("hold manufactured usage: %+v %v", usage, err)
			}
		})
	}
}
