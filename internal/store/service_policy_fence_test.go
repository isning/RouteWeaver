package store_test

import (
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestServicePolicyFenceRevalidatesAuthorityAndPreservesGenerationOnFailure(t *testing.T) {
	s, _, _, _, now := admissionFixture(t)
	policy, err := s.EffectivePolicy("account", now)
	if err != nil {
		t.Fatal(err)
	}
	fence := store.ServicePolicyFence{Checks: []store.ServicePolicyCheck{{Policy: policy, RouteIDs: []string{"route"}}}, ValidUntil: now.Add(time.Minute)}
	build := func(g uint64) (any, []store.RecordWrite, error) {
		return map[string]uint64{"generation": g}, []store.RecordWrite{{Kind: "refresh-receipts", ID: "one", Value: "committed"}}, nil
	}
	user := domain.User{ID: "account", Name: "Fixture", Enabled: false, QuotaBytes: 1000}
	if err = s.PutUser(user); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CompareServicePolicyAndGenerateRecord(fence, "desired", "one", nil, nil, build); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("revoked policy accepted: %v", err)
	}
	var value any
	if err = s.Get("refresh-receipts", "one", &value); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("partial associated write")
	}
	user.Enabled = true
	if err = s.PutUser(user); err != nil {
		t.Fatal(err)
	}
	generation, err := s.CompareServicePolicyAndGenerateRecord(fence, "desired", "one", nil, nil, build)
	if err != nil || generation != 1 {
		t.Fatalf("failed guard consumed generation: %d %v", generation, err)
	}
}

func TestServicePolicyFenceChecksCurrentUsageAndHoldsInsideWriter(t *testing.T) {
	for _, scenario := range []string{"below-quota", "quota-exhausted", "accounting-hold", "expired-budget", "group-changed", "unauthorized-route"} {
		t.Run(scenario, func(t *testing.T) {
			s, path, key, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			if scenario == "group-changed" {
				if err := s.Put("entitlements", "account", service.Entitlement{UserID: "account", Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
					t.Fatal(err)
				}
				if err := s.Put("user-groups", "members", service.Group{ID: "members", ServiceID: "plan", MemberIDs: []string{"account"}}); err != nil {
					t.Fatal(err)
				}
			}
			policy, err := s.EffectivePolicy("account", now)
			if err != nil {
				t.Fatal(err)
			}
			fence := store.ServicePolicyFence{Checks: []store.ServicePolicyCheck{{Policy: policy, RouteIDs: []string{"route"}}}, ValidUntil: now.Add(time.Minute)}
			other, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			switch scenario {
			case "below-quota", "quota-exhausted":
				n := int64(50)
				if scenario == "quota-exhausted" {
					n = 100
				}
				if err = other.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "meter", Epoch: "epoch", Sequence: 1, RawBytes: n, ObservedAt: now}); err != nil {
					t.Fatal(err)
				}
			case "accounting-hold":
				err = other.Put("accounting-holds", "one", store.AccountingHold{UserID: "account"})
			case "expired-budget":
				decision, e := other.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "expired"), now.Add(-time.Minute))
				err = e
				if !decision.Allowed {
					t.Fatalf("fixture budget notissued: %+v %v", decision, e)
				}
			case "group-changed":
				err = other.Put("user-groups", "members", service.Group{ID: "members", ServiceID: "different", MemberIDs: []string{"account"}})
			case "unauthorized-route":
				fence.Checks[0].RouteIDs = []string{"not-granted"}
			}
			if err != nil {
				t.Fatal(err)
			}
			err = s.CompareServicePolicyAndPutRecords(fence, nil, nil, []store.RecordWrite{{Kind: "service-grants", ID: "one", Value: "granted"}})
			if scenario == "below-quota" {
				if err != nil {
					t.Fatal("ordinary consumption prevented validrenewal", err)
				}
			} else {
				if !errors.Is(err, store.ErrConflict) {
					t.Fatalf("unsafe grant accepted: %v", err)
				}
				var got any
				if err = s.Get("service-grants", "one", &got); !errors.Is(err, store.ErrNotFound) {
					t.Fatal("grant survived failedguard")
				}
			}
		})
	}
}

func TestServicePolicyFenceChecksDeadlinesAfterGenerationBuild(t *testing.T) {
	for _, expiry := range []bool{false, true} {
		t.Run(fmt.Sprint(expiry), func(t *testing.T) {
			s, _, _, _, now := admissionFixture(t)
			deadline := time.Now().Add(150 * time.Millisecond)
			if expiry {
				var entitlement service.Entitlement
				if err := s.Get("entitlements", "account", &entitlement); err != nil {
					t.Fatal(err)
				}
				entitlement.ExpiresAt = &deadline
				if err := s.Put("entitlements", "account", entitlement); err != nil {
					t.Fatal(err)
				}
			}
			policy, err := s.EffectivePolicy("account", now)
			if err != nil {
				t.Fatal(err)
			}
			fence := store.ServicePolicyFence{Checks: []store.ServicePolicyCheck{{Policy: policy, RouteIDs: []string{"route"}}}, ValidUntil: now.Add(time.Minute)}
			if !expiry {
				fence.ValidUntil = deadline
			}
			built := false
			_, err = s.CompareServicePolicyAndGenerateRecord(fence, "desired", "one", nil, nil, func(g uint64) (any, []store.RecordWrite, error) {
				built = true
				time.Sleep(time.Until(deadline) + 10*time.Millisecond)
				return g, []store.RecordWrite{{Kind: "audit", ID: "new-grant", Value: "issued"}}, nil
			})
			if !errors.Is(err, store.ErrConflict) {
				t.Fatalf("late grant committed: %v", err)
			}
			if !built {
				t.Fatal("fixture expired before generation build")
			}
			var got any
			for _, kind := range []string{"desired", "audit"} {
				id := "one"
				if kind == "audit" {
					id = "new-grant"
				}
				if err = s.Get(kind, id, &got); !errors.Is(err, store.ErrNotFound) {
					t.Fatal("late transaction partiallycommitted")
				}
			}
		})
	}
}

func TestServicePolicyFenceDeadlineExpiresWhileWaitingForAnotherWriter(t *testing.T) {
	s, path, key, _, now := admissionFixture(t)
	other, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	policy, err := s.EffectivePolicy("account", now)
	if err != nil {
		t.Fatal(err)
	}
	held := make(chan struct{})
	release := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		_, e := other.CompareSetsAndGenerateRecord("unrelated", "lock", nil, nil, func(g uint64) (any, []store.RecordWrite, error) { close(held); <-release; return g, nil, nil })
		writerDone <- e
	}()
	<-held
	deadline := time.Now().Add(100 * time.Millisecond)
	fence := store.ServicePolicyFence{Checks: []store.ServicePolicyCheck{{Policy: policy, RouteIDs: []string{"route"}}}, ValidUntil: deadline}
	done := make(chan error, 1)
	go func() {
		done <- s.CompareServicePolicyAndPutRecords(fence, nil, nil, []store.RecordWrite{{Kind: "service-grants", ID: "one", Value: "late"}})
	}()
	time.Sleep(time.Until(deadline) + 10*time.Millisecond)
	close(release)
	if err = <-writerDone; err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, store.ErrConflict) {
		t.Fatalf("writer wait bypassed deadline: %v", err)
	}
	var got any
	if err = s.Get("service-grants", "one", &got); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("expired grant persisted")
	}
}
