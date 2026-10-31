package store_test

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

// These are canonical wire fixtures, not an implementation of derived state.
func liveBudget(owner, embedded string, granted, settled uint64, finite bool, expiry time.Time) map[string]any {
	return map[string]any{"accountId": owner, "leaseId": embedded, "routeId": "route", "grantedRaw": fmt.Sprint(granted), "settledRaw": fmt.Sprint(settled), "finite": finite, "expiresAt": expiry, "rate": service.Rate{ID: "default-1x", RouteID: "route", Micros: service.RateScale}}
}
func livePut(t *testing.T, s *store.Store, kind, id string, v any) {
	t.Helper()
	if err := s.Put(kind, id, v); err != nil {
		t.Fatal(err)
	}
}
func liveExpect(t *testing.T, s *store.Store, scope store.AdmissionScope, in store.AdmissionRequest, now time.Time, reason string) store.AdmissionDecision {
	t.Helper()
	v, err := s.AcquireAdmission(scope, in, now)
	if err != nil || v.Reason != reason || v.Allowed != (reason == "") {
		t.Fatalf("want reason %q: %+v, %v", reason, v, err)
	}
	return v
}
func liveWarm(t *testing.T, s *store.Store, scope store.AdmissionScope, now time.Time) {
	t.Helper()
	in := admissionRequest("entry1", "192.0.2.1", "warm")
	liveExpect(t, s, scope, in, now.Add(-2*time.Second), "")
	in.Final = true
	liveExpect(t, s, scope, in, now.Add(-time.Second), "presence-closed")
}

func TestLiveStateCanonicalExceptionalBudgetPrecedence(t *testing.T) {
	for _, warm := range []bool{false, true} {
		for _, tc := range []struct {
			name              string
			bad               any
			badFirst, expired bool
			want              string
		}{
			{"unsigned-underflow-live", "underflow", true, false, "invalid amount or rate"},
			{"unsigned-underflow-expired", "underflow", true, true, "quota-budget-pending"},
			{"pending-before-underflow", "underflow", false, false, "quota-budget-pending"},
			{"typed-unknown-owner-first", map[string]any{"accountId": []string{"unknown"}}, true, false, "cannot unmarshal"},
			{"pending-before-typed-unknown-owner", map[string]any{"accountId": []string{"unknown"}}, false, false, "quota-budget-pending"},
			{"foreign-typed-first", map[string]any{"accountId": "foreign", "finite": "bad"}, true, false, "cannot unmarshal"},
			{"weighted-overflow-first", "overflow", true, false, "weighted usage overflow"},
			{"pending-before-overflow", "overflow", false, false, "quota-budget-pending"},
		} {
			t.Run(fmt.Sprintf("warm=%t/%s", warm, tc.name), func(t *testing.T) {
				s, _, _, scope, now := admissionFixture(t)
				finiteAdmissionPlan(t, s, 100)
				if warm {
					liveWarm(t, s, scope, now)
				}
				expiry := now.Add(time.Hour)
				if tc.expired {
					expiry = now
				}
				bad := tc.bad
				if tag, _ := tc.bad.(string); tag == "underflow" {
					bad = liveBudget("account", "embedded", 0, 1, true, expiry)
				}
				if tag, _ := tc.bad.(string); tag == "overflow" {
					b := liveBudget("account", "embedded", math.MaxInt64, 0, true, expiry)
					b["rate"] = service.Rate{Micros: 2 * service.RateScale}
					bad = b
				}
				badID, pendingID := "a-bad", "z-pending"
				if !tc.badFirst {
					badID, pendingID = "z-bad", "a-pending"
				}
				livePut(t, s, "admission-budgets", badID, bad)
				if !tc.expired {
					livePut(t, s, "admission-budgets", pendingID, liveBudget("account", "pending", 1, 0, true, now))
				}
				v, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
				if tc.want == "quota-budget-pending" {
					if err != nil || v.Allowed || v.Reason != tc.want {
						t.Fatalf("canonical pending order lost: %+v %v", v, err)
					}
				} else if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("want %q, got %+v %v", tc.want, v, err)
				}
				if err := s.Remove("admission-budgets", badID); err != nil {
					t.Fatal(err)
				}
				if err := s.Remove("admission-budgets", pendingID); err != nil && err != store.ErrNotFound {
					t.Fatal(err)
				}
				liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "repaired"), now, "")
			})
		}
	}
}

func TestLiveStateBudgetRepresentationAndCanonicalIdentity(t *testing.T) {
	for _, tc := range []struct {
		name             string
		finite           bool
		granted, settled uint64
		expiry           time.Duration
		reason           string
	}{
		{"finite-zero-expired", true, 5, 5, -time.Second, ""},
		{"unlimited-zero-live", false, 0, 0, time.Hour, "quota-budget-pending"},
		{"unlimited-zero-expired", false, 0, 0, -time.Second, "quota-budget-pending"},
		{"finite-outstanding", true, 70, 0, time.Hour, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			livePut(t, s, "admission-budgets", "canonical-not-embedded", liveBudget("account", "same-embedded", tc.granted, tc.settled, tc.finite, now.Add(tc.expiry)))
			v := liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, tc.reason)
			if tc.name == "finite-outstanding" && (v.ByteBudget == nil || *v.ByteBudget != 30) {
				t.Fatalf("canonical reservation lost: %+v", v)
			}
		})
	}
	t.Run("duplicate-embedded-ids-count-separately", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		finiteAdmissionPlan(t, s, 100)
		liveWarm(t, s, scope, now)
		for _, id := range []string{"canonical-one", "canonical-two"} {
			livePut(t, s, "admission-budgets", id, liveBudget("account", "same-embedded", 40, 0, true, now.Add(time.Hour)))
		}
		v := liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, "")
		if v.ByteBudget == nil || *v.ByteBudget != 20 {
			t.Fatalf("duplicate embedded identities collapsed: %+v", v)
		}
	})
}

func TestLiveStateExpiredObligationsSettleIndependentlyAndDenialsCommit(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, int64(3*store.AdmissionBudgetChunk))
	a, b := admissionRequest("entry1", "192.0.2.1", "a"), admissionRequest("entry2", "192.0.2.1", "b")
	av := liveExpect(t, s, scope, a, now, "")
	liveExpect(t, s, scope, b, now, "")
	if err := s.ReleaseAdmission(scope, av.LeaseID, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	probe := admissionRequest("entry1", "192.0.2.2", "probe")
	liveExpect(t, s, scope, probe, now.Add(31*time.Second), "quota-budget-pending")
	a.AdmittedBytes = 10
	liveExpect(t, s, scope, a, now.Add(32*time.Second), "quota-budget-pending")
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 10 {
		t.Fatalf("denial discarded partial settlement: %+v %v", usage, err)
	}
	a.Final = true
	liveExpect(t, s, scope, a, now.Add(33*time.Second), "presence-closed")
	liveExpect(t, s, scope, a, now.Add(34*time.Second), "presence-closed")
	liveExpect(t, s, scope, probe, now.Add(35*time.Second), "quota-budget-pending")
	b.AdmittedBytes = store.AdmissionBudgetChunk
	liveExpect(t, s, scope, b, now.Add(36*time.Second), "quota-budget-pending")
	liveExpect(t, s, scope, probe, now.Add(37*time.Second), "")
	usage, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != int64(store.AdmissionBudgetChunk+10) {
		t.Fatalf("late settlement total: %+v %v", usage, err)
	}
}

func TestLiveStateLeaseCanonicalIDsOwnerMovesAndBackwardsTime(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	liveWarm(t, s, scope, now)
	lease := func(owner, ip string, expiry time.Time) map[string]any {
		return map[string]any{"id": "same-embedded", "binding": store.EntryAdmissionBinding{UserID: owner}, "clientIp": ip, "expiresAt": expiry}
	}
	livePut(t, s, "entry-admission-leases", "canonical-one", lease("account", "192.0.2.8", now.Add(5*time.Second)))
	livePut(t, s, "entry-admission-leases", "canonical-two", lease("account", "192.0.2.8", now.Add(5*time.Second)))
	in := admissionRequest("entry1", "192.0.2.1", "probe")
	liveExpect(t, s, scope, in, now, "ip-limit")
	livePut(t, s, "entry-admission-leases", "canonical-one", lease("foreign", "192.0.2.8", now.Add(5*time.Second)))
	liveExpect(t, s, scope, in, now, "ip-limit")
	// At equality the foreign-IP leases are expired; future admission advances the watermark.
	inFinal := admissionRequest("entry1", "192.0.2.1", "future")
	liveExpect(t, s, scope, inFinal, now.Add(5*time.Second), "")
	inFinal.Final = true
	final := liveExpect(t, s, scope, inFinal, now.Add(6*time.Second), "presence-closed")
	if err := s.Remove("entry-admission-leases", final.LeaseID); err != nil {
		t.Fatal(err)
	}
	// An earlier-arriving request must rediscover the other canonical record.
	liveExpect(t, s, scope, in, now, "ip-limit")
	if err := s.Remove("entry-admission-leases", "canonical-two"); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, s, scope, in, now, "")
}

func TestLiveStateBudgetExceptionsDoNotPreemptIPDenial(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	liveWarm(t, s, scope, now)
	livePut(t, s, "entry-admission-leases", "occupant", map[string]any{"id": "occupant", "binding": store.EntryAdmissionBinding{UserID: "account"}, "clientIp": "192.0.2.8", "expiresAt": now.Add(time.Hour)})
	livePut(t, s, "admission-budgets", "bad", json.RawMessage(`{"accountId":{},"finite":"bad"}`))
	liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, "ip-limit")
}

func TestLiveStateGenericWritersMoveBudgetOwners(t *testing.T) {
	for _, writer := range []string{"put", "update", "compare", "generate"} {
		t.Run(writer, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			old := liveBudget("account", "embedded", 30, 0, true, now.Add(time.Hour))
			livePut(t, s, "admission-budgets", "movable", old)
			sequence := 0
			check := func(want uint64) {
				t.Helper()
				sequence++
				in := admissionRequest("entry1", "192.0.2.1", fmt.Sprintf("probe-%d", sequence))
				v := liveExpect(t, s, scope, in, now, "")
				if v.ByteBudget == nil || *v.ByteBudget != want {
					t.Fatalf("want allowance %d: %+v", want, v)
				}
				in.Final = true
				liveExpect(t, s, scope, in, now, "presence-closed")
			}
			change := func(owner string) {
				t.Helper()
				next := liveBudget(owner, "embedded", 30, 0, true, now.Add(time.Hour))
				var err error
				switch writer {
				case "put":
					err = s.Put("admission-budgets", "movable", next)
				case "update":
					err = s.UpdateRecords("admission-budgets", "movable", func(json.RawMessage) ([]store.RecordWrite, error) {
						return []store.RecordWrite{{Kind: "admission-budgets", ID: "movable", Value: next}}, nil
					})
				case "compare":
					err = s.CompareAndPutRecords([]store.RecordCompare{{Kind: "admission-budgets", ID: "movable", Expected: old}}, []store.RecordWrite{{Kind: "admission-budgets", ID: "movable", Value: next}})
				case "generate":
					_, err = s.GenerateRecord("admission-budgets", "movable", func(uint64) (any, error) { return next, nil })
				}
				if err != nil {
					t.Fatal(err)
				}
				old = next
			}
			check(70)
			change("foreign")
			check(100)
			change("account")
			check(70)
			if err := s.Remove("admission-budgets", "movable"); err != nil {
				t.Fatal(err)
			}
			check(100)
		})
	}
}

func TestLiveStateBudgetBackwardsTimeAndZeroRate(t *testing.T) {
	t.Run("backwards-reconstructs-expired-reservation", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		finiteAdmissionPlan(t, s, 100)
		liveWarm(t, s, scope, now)
		livePut(t, s, "admission-budgets", "historical", liveBudget("account", "historical", 30, 0, true, now.Add(5*time.Second)))
		in := admissionRequest("entry1", "192.0.2.1", "probe")
		liveExpect(t, s, scope, in, now.Add(5*time.Second), "quota-budget-pending")
		v := liveExpect(t, s, scope, in, now, "")
		if v.ByteBudget == nil || *v.ByteBudget != 70 {
			t.Fatalf("backwards reservation: %+v", v)
		}
	})
	t.Run("zero-rate-still-reserves-raw-without-charging", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		finiteAdmissionPlan(t, s, 100)
		if err := s.SetRate(service.Rate{ID: "free", RouteID: "route", Micros: 0, EffectiveAt: now.Add(-time.Hour)}); err != nil {
			t.Fatal(err)
		}
		for _, presence := range []string{"a", "b"} {
			in := admissionRequest("entry1", "192.0.2.1", presence)
			v := liveExpect(t, s, scope, in, now, "")
			if v.ByteBudget == nil || *v.ByteBudget != store.AdmissionBudgetChunk {
				t.Fatalf("zero-rate ceiling: %+v", v)
			}
			in.AdmittedBytes = 17
			in.Final = true
			liveExpect(t, s, scope, in, now.Add(time.Second), "presence-closed")
		}
		usage, err := s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 34 || usage.WeightedBytes != 0 {
			t.Fatalf("zero-rate usage: %+v %v", usage, err)
		}
	})
}

func TestLiveStateMalformedLeaseUnknownOwnerDoesNotDisappear(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	liveWarm(t, s, scope, now)
	livePut(t, s, "entry-admission-leases", "bad-owner", json.RawMessage(`{"binding":{"userId":{}},"expiresAt":"2000-01-01T00:00:00Z"}`))
	_, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
	if err == nil || !strings.Contains(err.Error(), "cannot unmarshal") {
		t.Fatalf("expired malformed owner silently omitted: %v", err)
	}
	if err = s.Remove("entry-admission-leases", "bad-owner"); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, "")
}

func TestLiveStateFiniteZeroBudgetStillFencesAdministrativeRateChange(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	liveWarm(t, s, scope, now)
	livePut(t, s, "admission-budgets", "zero", liveBudget("account", "zero", 5, 5, true, now.Add(time.Hour)))
	if err := s.SetRate(service.Rate{ID: "new", RouteID: "route", Micros: 2 * service.RateScale, EffectiveAt: now.Add(time.Second)}); err == nil {
		t.Fatal("finite zero-outstanding canonical rate guard was skipped")
	}
}

func TestLiveStateAcrossInstancesUsesLogicalIPUnionAndStreamCount(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	var plan service.Plan
	if err := s.Get("services", "plan", &plan); err != nil {
		t.Fatal(err)
	}
	plan.ConnectionLimit = 2
	if err := s.PutServicePlan(plan); err != nil {
		t.Fatal(err)
	}
	other := store.AdmissionScope{NodeID: "node-two", InstanceID: "instance-two", EnrollmentEpoch: "enrollment-two"}
	livePut(t, s, "core-instances", other.InstanceID, domain.CoreInstance{ID: other.InstanceID, HostID: other.NodeID, AdapterID: "fixture/admission"})
	livePut(t, s, "instance-enrollments", other.InstanceID, map[string]any{"scope": other, "expiresAt": now.Add(time.Hour)})
	livePut(t, s, "managed-endpoints", "entry3", domain.ManagedEndpoint{ID: "entry3", InstanceID: other.InstanceID})
	if err := s.TenantPut("account", "platform-entries", "entry3", map[string]any{"id": "entry3", "userId": "account", "routeId": "route", "credentialVersion": "v1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEntryAdmissionBinding(store.EntryAdmissionBinding{ID: "entry3", InstanceID: other.InstanceID, EntryID: "entry3", SubjectID: "subject", UserID: "account", RouteID: "route", GrantID: "entry3", CredentialVersion: "v1"}); err != nil {
		t.Fatal(err)
	}
	a := liveExpect(t, s, scope, admissionRequest("entry1", "::ffff:192.0.2.1", "a"), now, "")
	b := liveExpect(t, s, other, admissionRequest("entry3", "192.0.2.1", "b"), now, "")
	liveExpect(t, s, other, admissionRequest("entry3", "192.0.2.2", "c"), now, "ip-limit")
	liveExpect(t, s, other, admissionRequest("entry3", "192.0.2.1", "c"), now, "connection-limit")
	if err := s.ReleaseAdmission(scope, a.LeaseID, now); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.2", "c"), now, "ip-limit")
	if err := s.ReleaseAdmission(other, b.LeaseID, now); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.2", "c"), now, "")
}

func TestLiveStateReservationsRoundEachFrozenRateSeparately(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	liveWarm(t, s, scope, now)
	for i, rate := range []int64{1, 500000, 1500000} {
		b := liveBudget("account", "same-embedded", 1, 0, true, now.Add(time.Hour))
		b["rate"] = service.Rate{Micros: rate}
		livePut(t, s, "admission-budgets", fmt.Sprintf("reservation-%d", i), b)
	}
	// Independent worked result: ceil(.000001)+ceil(.5)+ceil(1.5)=1+1+2=4.
	v := liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, "")
	if v.ByteBudget == nil || *v.ByteBudget != 96 {
		t.Fatalf("per-budget rounding was combined: %+v", v)
	}
}

func TestLiveStateAggregateOverflowKeepsCanonicalPendingOrder(t *testing.T) {
	for _, pendingFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(pendingFirst), func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			livePut(t, s, "admission-budgets", "b-large", liveBudget("account", "large", math.MaxInt64, 0, true, now.Add(time.Hour)))
			livePut(t, s, "admission-budgets", "c-small", liveBudget("account", "small", 1, 0, true, now.Add(time.Hour)))
			id := "z-pending"
			if pendingFirst {
				id = "a-pending"
			}
			livePut(t, s, "admission-budgets", id, liveBudget("account", "pending", 1, 0, true, now))
			v, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
			if pendingFirst {
				if err != nil || v.Reason != "quota-budget-pending" {
					t.Fatalf("pending order: %+v %v", v, err)
				}
			} else if err == nil || err.Error() != "reservation aggregate overflow" {
				t.Fatalf("overflow order: %+v %v", v, err)
			}
		})
	}
}

func TestLiveStateErrorsRollBackSettlementAcrossDerivedDomains(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "stream")
	liveExpect(t, s, scope, in, now, "")
	livePut(t, s, "admission-budgets", "bad-foreign", json.RawMessage(`{"accountId":"foreign","finite":[]}`))
	in.AdmittedBytes = 10
	if _, err := s.AcquireAdmission(scope, in, now.Add(time.Second)); err == nil {
		t.Fatal("malformed budget did not produce canonical error")
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 0 {
		t.Fatalf("error committed settlement: %+v %v", usage, err)
	}
	if err = s.Remove("admission-budgets", "bad-foreign"); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, s, scope, in, now.Add(2*time.Second), "")
	usage, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 10 {
		t.Fatalf("retry after rollback lost settlement: %+v %v", usage, err)
	}
}

func TestLiveStateExceptionalDomainSurvivesReopenAndRepairs(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	liveWarm(t, s, scope, now)
	livePut(t, s, "admission-budgets", "a-pending", liveBudget("account", "pending", 1, 0, true, now))
	livePut(t, s, "admission-budgets", "z-malformed", json.RawMessage(`{"accountId":{}}`))
	in := admissionRequest("entry1", "192.0.2.1", "probe")
	liveExpect(t, s, scope, in, now, "quota-budget-pending")
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	liveExpect(t, reopened, scope, in, now, "quota-budget-pending")
	if err = reopened.Remove("admission-budgets", "a-pending"); err != nil {
		t.Fatal(err)
	}
	if _, err = reopened.AcquireAdmission(scope, in, now); err == nil || !strings.Contains(err.Error(), "cannot unmarshal") {
		t.Fatalf("unknown-owner exception disappeared across reopen: %v", err)
	}
	if err = reopened.Remove("admission-budgets", "z-malformed"); err != nil {
		t.Fatal(err)
	}
	liveExpect(t, reopened, scope, in, now, "")
}
