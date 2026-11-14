package store

import (
	"context"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func TestQuotaForecastUsesCurrentOverviewAndReservations(t *testing.T) {
	s, now := quotaWindowFixture(t)
	s.PutUser(domain.User{ID: "account", Name: "Synthetic", Enabled: true})
	plan := service.Plan{ID: "plan", Name: "Plan", QuotaBytes: 1000, RouteIDs: []string{"route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	s.Put("services", "plan", plan)
	s.Put("entitlements", "account", service.Entitlement{UserID: "account", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: plan.Cycle})
	s.ObserveQuotaCoverageContext(context.Background(), "account", now)
	scope := AdmissionScope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	in := AdmissionRequest{EntryID: "entry", SubjectID: "subject", CredentialVersion: "v1", ClientIP: "192.0.2.1", PresenceID: "forecast"}
	first, e := s.AcquireAdmission(scope, in, now.Add(time.Second))
	if e != nil || !first.Allowed {
		t.Fatalf("acquire %+v %v", first, e)
	}
	in.AdmittedBytes = 75
	in.Final = true
	if _, e = s.AcquireAdmission(scope, in, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	at := now.Add(quotaCoverageDuration)
	policy, e := s.EffectivePolicy("account", at)
	if e != nil {
		t.Fatal(e)
	}
	cycle, e := policy.Entitlement.Cycle.Window(at)
	if e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("account", cycle.Start, at.Add(time.Nanosecond))
	if e != nil {
		t.Fatal(e)
	}
	f, e := s.QuotaForecastContext(context.Background(), "account", at, policy, cycle, usage, false)
	if e != nil || !f.Available || f.RemainingBytes != "925" || f.EstimatedExhaustionAt == nil {
		t.Fatalf("forecast %+v %v", f, e)
	}
	// Concurrent quota changes may make the optional projection unavailable,
	// but must never return another snapshot's balance beside this overview.
	changed := make(chan error, 1)
	go func() {
		alternate := plan
		for i := 0; i < 8; i++ {
			alternate.QuotaBytes = 2000
			if e := s.Put("services", "plan", alternate); e != nil {
				changed <- e
				return
			}
			alternate.QuotaBytes = 1000
			if e := s.Put("services", "plan", alternate); e != nil {
				changed <- e
				return
			}
		}
		changed <- nil
	}()
	for i := 0; i < 8; i++ {
		concurrent, err := s.QuotaForecastContext(context.Background(), "account", at, policy, cycle, usage, false)
		if err != nil {
			t.Fatal(err)
		}
		if concurrent.Available && concurrent.RemainingBytes != "925" {
			t.Fatalf("mixed overview snapshots %+v", concurrent)
		}
	}
	if err := <-changed; err != nil {
		t.Fatal(err)
	}
	original := *f.EstimatedExhaustionAt
	generation := quotaCheckpoint(t, s, "account").Generation
	plan.QuotaBytes = 2000
	s.Put("services", "plan", plan)
	stale, e := s.QuotaForecastContext(context.Background(), "account", at, policy, cycle, usage, false)
	if e != nil || stale.Available || stale.Reason != "overview_changed" {
		t.Fatalf("stale overview %+v %v", stale, e)
	}
	policy, _ = s.EffectivePolicy("account", at)
	f, e = s.QuotaForecastContext(context.Background(), "account", at, policy, cycle, usage, false)
	if e != nil || !f.Available || f.RemainingBytes != "1925" || !f.EstimatedExhaustionAt.After(original) || quotaCheckpoint(t, s, "account").Generation != generation {
		t.Fatalf("new quota %+v %v", f, e)
	}
	// A successful new live reservation is deducted only from the estimate.
	in.PresenceID = "reserved"
	in.Final = false
	in.AdmittedBytes = 0
	lease, e := s.AcquireAdmission(scope, in, at)
	if e != nil || !lease.Allowed {
		t.Fatalf("reserved %+v %v", lease, e)
	}
	f, e = s.QuotaForecastContext(context.Background(), "account", at, policy, cycle, usage, false)
	if e != nil || f.RemainingBytes != "1925" || f.ReservedBytes == "0" {
		t.Fatalf("reservation %+v %v", f, e)
	}
	denied, e := s.QuotaForecastContext(context.Background(), "other", at, policy, cycle, usage, false)
	if e != nil || denied.Available {
		t.Fatalf("foreign %+v %v", denied, e)
	}
}
