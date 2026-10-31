package store_test

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func admissionFixture(t *testing.T) (*store.Store, string, []byte, store.AdmissionScope, time.Time) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{21}, 32)
	s, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Now().UTC()
	scope := store.AdmissionScope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment"}
	put := func(kind, id string, v any) {
		t.Helper()
		if e := s.Put(kind, id, v); e != nil {
			t.Fatal(e)
		}
	}
	put("core-instances", scope.InstanceID, domain.CoreInstance{ID: scope.InstanceID, HostID: scope.NodeID, AdapterID: "fixture/admission"})
	put("instance-enrollments", scope.InstanceID, map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour), "revoked": false})
	if e := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: true, QuotaBytes: 1000}); e != nil {
		t.Fatal(e)
	}
	put("services", "plan", service.Plan{ID: "plan", Name: "Plan", QuotaBytes: 0, RouteIDs: []string{"route"}, OnlineIPLimit: 1, EntryRateBPS: 1024})
	put("entitlements", "account", service.Entitlement{UserID: "account", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}})
	for _, entry := range []string{"entry1", "entry2"} {
		put("managed-endpoints", entry, domain.ManagedEndpoint{ID: entry, InstanceID: scope.InstanceID})
		if e := s.TenantPut("account", "platform-entries", entry, map[string]any{"id": entry, "userId": "account", "routeId": "route", "credentialVersion": "v1", "revoked": false}); e != nil {
			t.Fatal(e)
		}
		if e := s.SetEntryAdmissionBinding(store.EntryAdmissionBinding{ID: entry, InstanceID: scope.InstanceID, EntryID: entry, SubjectID: "subject", UserID: "account", RouteID: "route", GrantID: entry, CredentialVersion: "v1"}); e != nil {
			t.Fatal(e)
		}
	}
	return s, path, key, scope, now
}
func admissionRequest(entry, ip, presence string) store.AdmissionRequest {
	return store.AdmissionRequest{EntryID: entry, SubjectID: "subject", CredentialVersion: "v1", ClientIP: ip, PresenceID: presence}
}
func TestAdmissionUnionCountsNormalizedIPsAcrossEntriesAndDurablyRenews(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	first, e := s.AcquireAdmission(scope, admissionRequest("entry1", "::ffff:192.0.2.10", "presence1"), now)
	if e != nil || !first.Allowed || first.AccountID != "account" || first.EntryRateBPS != 1024 {
		t.Fatalf("first %+v %v", first, e)
	}
	second, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.10", "presence2"), now)
	if e != nil || !second.Allowed {
		t.Fatalf("same account IP double counted %+v %v", second, e)
	}
	denied, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.11", "presence3"), now)
	if e != nil || denied.Allowed || denied.Reason != "ip-limit" {
		t.Fatalf("new IP bypassed cap %+v %v", denied, e)
	}
	secondStore, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer secondStore.Close()
	renew, e := secondStore.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.10", "presence1"), now.Add(10*time.Second))
	if e != nil || !renew.Allowed || renew.LeaseID != first.LeaseID {
		t.Fatalf("durable renewal %+v %v", renew, e)
	}
	if e = s.ReleaseAdmission(scope, first.LeaseID, now.Add(11*time.Second)); e != nil {
		t.Fatal(e)
	}
	denied, e = s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.11", "presence3"), now.Add(12*time.Second))
	if e != nil || denied.Allowed {
		t.Fatalf("releasing one connection dropped another presence %+v %v", denied, e)
	}
	if e = s.ReleaseAdmission(scope, second.LeaseID, now.Add(13*time.Second)); e != nil {
		t.Fatal(e)
	}
	accepted, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.11", "presence3"), now.Add(14*time.Second))
	if e != nil || !accepted.Allowed {
		t.Fatalf("released slot remained occupied %+v %v", accepted, e)
	}
}
func TestAdmissionRenewalRespectsRevocationQuotaAndHolds(t *testing.T) {
	for _, reason := range []string{"disabled", "expired", "credential-revoked", "route-not-entitled", "exhausted", "accounting-pending", "enrollment-revoked"} {
		t.Run(reason, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			in := admissionRequest("entry1", "2001:db8::1", "presence")
			if lease, e := s.AcquireAdmission(scope, in, now); e != nil || !lease.Allowed {
				t.Fatalf("initial %+v %v", lease, e)
			}
			switch reason {
			case "disabled":
				if e := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: false}); e != nil {
					t.Fatal(e)
				}
			case "expired":
				expires := now.Add(time.Second)
				s.Put("entitlements", "account", service.Entitlement{UserID: "account", ServiceID: "plan", ExpiresAt: &expires, Cycle: service.CyclePolicy{Mode: "none"}})
			case "credential-revoked":
				s.TenantPut("account", "platform-entries", "entry1", map[string]any{"id": "entry1", "userId": "account", "routeId": "route", "credentialVersion": "v2"})
			case "route-not-entitled":
				s.Put("services", "plan", service.Plan{ID: "plan", Name: "Plan", QuotaBytes: 1000, OnlineIPLimit: 1})
			case "exhausted":
				s.Put("services", "plan", service.Plan{ID: "plan", Name: "Plan", QuotaBytes: 1000, RouteIDs: []string{"route"}, OnlineIPLimit: 1})
				if e := s.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "meter", Epoch: "epoch", Sequence: 1, RawBytes: 1000, ObservedAt: now}); e != nil {
					t.Fatal(e)
				}
			case "accounting-pending":
				s.Put("accounting-holds", "fixture", store.AccountingHold{UserID: "account", Reason: "unresolved interval"})
			case "enrollment-revoked":
				replacement := scope
				replacement.EnrollmentEpoch = "replacement"
				s.Put("instance-enrollments", scope.InstanceID, map[string]any{"scope": replacement, "expiresAt": now.Add(time.Hour)})
			}
			lease, e := s.AcquireAdmission(scope, in, now.Add(2*time.Second))
			if e != nil || lease.Allowed || lease.Reason != reason {
				t.Fatalf("revoked renewal %+v %v", lease, e)
			}
		})
	}
}
func TestAdmissionIPClaimIsAtomicAcrossStoreHandles(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	other, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	var wg sync.WaitGroup
	results := make(chan store.AdmissionDecision, 2)
	errors := make(chan error, 2)
	for i, db := range []*store.Store{s, other} {
		wg.Add(1)
		go func(i int, db *store.Store) {
			defer wg.Done()
			ip, presence := "192.0.2.1", "first"
			if i == 1 {
				ip, presence = "192.0.2.2", "second"
			}
			v, e := db.AcquireAdmission(scope, admissionRequest("entry1", ip, presence), now)
			results <- v
			errors <- e
		}(i, db)
	}
	wg.Wait()
	close(results)
	close(errors)
	allowed := 0
	for e := range errors {
		if e != nil {
			t.Fatal(e)
		}
	}
	for v := range results {
		if v.Allowed {
			allowed++
		}
	}
	if allowed != 1 {
		t.Fatalf("simultaneous last IP slot granted %d times", allowed)
	}
}
func TestAdmissionScopesPresenceAndExpiresStaleIPs(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	in := admissionRequest("entry1", "192.0.2.1", "presence")
	first, e := s.AcquireAdmission(scope, in, now)
	if e != nil || !first.Allowed {
		t.Fatal(e)
	}
	in.ClientIP = "192.0.2.2"
	if _, e = s.AcquireAdmission(scope, in, now); e != store.ErrConflict {
		t.Fatalf("live presence switched address %v", e)
	}
	fake := scope
	fake.EnrollmentEpoch = "wrong"
	if e = s.ReleaseAdmission(fake, first.LeaseID, now); e != store.ErrConflict {
		t.Fatalf("cross-enrollment release %v", e)
	}
	expired, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.2", "new"), now.Add(31*time.Second))
	if e != nil || expired.Allowed || expired.Reason != "quota-budget-pending" {
		t.Fatalf("expired unreported consumption was forgotten %+v %v", expired, e)
	}
	in.ClientIP = "192.0.2.1"
	in.Final = true
	if _, e = s.AcquireAdmission(scope, in, now.Add(32*time.Second)); e != nil {
		t.Fatal(e)
	}
	expired, e = s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.2", "new"), now.Add(33*time.Second))
	if e != nil || !expired.Allowed {
		t.Fatalf("settled stale presence retained %+v %v", expired, e)
	}
	for _, ip := range []string{"", "example.test", "0.0.0.0", "ff02::1", "fe80::1%zone", "::ffff:0.0.0.0", "::ffff:224.0.0.1", "255.255.255.255"} {
		if _, e = s.AcquireAdmission(scope, admissionRequest("entry1", ip, "bad"), now); e == nil {
			t.Fatalf("non-client IP %q accepted", ip)
		}
	}
}

func TestConnectionLimitCountsIndependentStreamsOnSameIPAndRenewsAtCap(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	var plan service.Plan
	if e := s.Get("services", "plan", &plan); e != nil {
		t.Fatal(e)
	}
	plan.ConnectionLimit = 2
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatal(e)
	}
	a, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "stream-a"), now)
	if e != nil || !a.Allowed {
		t.Fatalf("a %+v %v", a, e)
	}
	b, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.1", "stream-b"), now)
	if e != nil || !b.Allowed {
		t.Fatalf("b %+v %v", b, e)
	}
	c, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "stream-c"), now)
	if e != nil || c.Allowed || c.Reason != "connection-limit" {
		t.Fatalf("same-IP third stream bypassed independent cap %+v %v", c, e)
	}
	renew, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "stream-a"), now.Add(time.Second))
	if e != nil || !renew.Allowed || renew.LeaseID != a.LeaseID {
		t.Fatalf("at-cap renewal %+v %v", renew, e)
	}
	if e = s.ReleaseAdmission(scope, b.LeaseID, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	c, e = s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "stream-c"), now.Add(3*time.Second))
	if e != nil || !c.Allowed {
		t.Fatalf("released stream slot %+v %v", c, e)
	}
}

func TestConnectionClaimIsAtomicAcrossStoreHandlesWithSameIP(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	var plan service.Plan
	if e := s.Get("services", "plan", &plan); e != nil {
		t.Fatal(e)
	}
	plan.ConnectionLimit = 1
	if e := s.PutServicePlan(plan); e != nil {
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
			id := "one"
			if i == 1 {
				id = "two"
			}
			v, e := db.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", id), now)
			results <- v
			errors <- e
		}(i, db)
	}
	close(start)
	allowed, denied := 0, 0
	for range 2 {
		v := <-results
		if e := <-errors; e != nil {
			t.Fatal(e)
		}
		if v.Allowed {
			allowed++
		} else if v.Reason == "connection-limit" {
			denied++
		}
	}
	if allowed != 1 || denied != 1 {
		t.Fatalf("same-IP concurrent stream claim: allowed=%d denied=%d", allowed, denied)
	}
}

func TestAdmissionStatusReportsLeasesNotHardwareAndReleasesStreamsIndependently(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	a, e := s.AcquireAdmission(scope, admissionRequest("entry1", "::ffff:192.0.2.1", "a"), now)
	if e != nil || !a.Allowed {
		t.Fatal(e)
	}
	b, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.1", "b"), now)
	if e != nil || !b.Allowed {
		t.Fatal(e)
	}
	status, e := s.AdmissionStatus("account", now)
	if e != nil || status.ActiveStreams != 2 || len(status.OnlineIPs) != 1 || status.OnlineIPs[0] != "192.0.2.1" || len(status.Entries) != 2 || status.MaxLeaseSeconds != 30 {
		t.Fatalf("status %+v %v", status, e)
	}
	if e = s.ReleaseAdmission(scope, a.LeaseID, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	status, e = s.AdmissionStatus("account", now.Add(2*time.Second))
	if e != nil || status.ActiveStreams != 1 || len(status.OnlineIPs) != 1 {
		t.Fatalf("partial release %+v %v", status, e)
	}
	status, e = s.AdmissionStatus("account", now.Add(31*time.Second))
	if e != nil || status.ActiveStreams != 0 || len(status.OnlineIPs) != 0 {
		t.Fatalf("expired reservations %+v %v", status, e)
	}
}

func TestIndividualConnectionAndExactRouteOverridesFeedAdmission(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	var ent service.Entitlement
	if e := s.Get("entitlements", "account", &ent); e != nil {
		t.Fatal(e)
	}
	limit := 1
	ent.ConnectionLimitOverride = &limit
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatal(e)
	}
	first := admissionRequest("entry1", "192.0.2.1", "first")
	if v, e := s.AcquireAdmission(scope, first, now); e != nil || !v.Allowed {
		t.Fatalf("first %+v %v", v, e)
	}
	second := admissionRequest("entry2", "192.0.2.1", "second")
	if v, e := s.AcquireAdmission(scope, second, now); e != nil || v.Allowed || v.Reason != "connection-limit" {
		t.Fatalf("individual limit bypass %+v %v", v, e)
	}
	limit = 0
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatal(e)
	}
	if v, e := s.AcquireAdmission(scope, second, now); e != nil || !v.Allowed {
		t.Fatalf("zero override did not remove configured cap %+v %v", v, e)
	}
	none := []string{}
	ent.RouteIDsOverride = &none
	if e := s.PutEntitlement(ent); e != nil {
		t.Fatal(e)
	}
	if v, e := s.AcquireAdmission(scope, first, now.Add(time.Second)); e != nil || v.Allowed || v.Reason != "route-not-entitled" {
		t.Fatalf("exact route revoke ignored %+v %v", v, e)
	}
}

func TestConnectionCapReductionRequiresExistingStreamsToFit(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	if e := s.Put("routes", "route", domain.Route{ID: "route", Name: "Route"}); e != nil {
		t.Fatal(e)
	}
	var plan service.Plan
	if e := s.Get("services", "plan", &plan); e != nil {
		t.Fatal(e)
	}
	plan.ConnectionLimit = 3
	if e := s.PutServicePlan(plan); e != nil {
		t.Fatal(e)
	}
	a, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "a"), now)
	if e != nil || !a.Allowed {
		t.Fatal(e)
	}
	b, e := s.AcquireAdmission(scope, admissionRequest("entry2", "192.0.2.1", "b"), now)
	if e != nil || !b.Allowed {
		t.Fatal(e)
	}
	plan.ConnectionLimit = 1
	preview, e := s.PreviewPolicyChange(service.PolicyChange{Service: &plan}, now)
	if e != nil || len(preview.Blockers) == 0 {
		t.Fatalf("missing reduction blocker: %+v %v", preview, e)
	}
	if _, e = s.ApplyPolicyChange(service.PolicyChange{Service: &plan}, preview.Revision, now); e == nil {
		t.Fatal("previewed over-cap reduction committed")
	}

	if e = s.PutServicePlan(plan); e == nil {
		t.Fatal("cap reduction accepted with more active streams than the new limit")
	}
	if e = s.ReleaseAdmission(scope, b.LeaseID, now); e != nil {
		t.Fatal(e)
	}
	if e = s.PutServicePlan(plan); e != nil {
		t.Fatalf("cap reduction still blocked after active streams fit: %v", e)
	}
	renew, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "a"), now.Add(time.Second))
	if e != nil || !renew.Allowed {
		t.Fatalf("at-cap renewal %+v %v", renew, e)
	}
}
