package store_test

import (
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestProviderSuspensionReviewClipsActualLeaseToEvidence(t *testing.T) {
	for _, boundary := range []string{"freshness", "cycle", "service"} {
		t.Run(boundary, func(t *testing.T) {
			s, scope, now, _, _ := providerRouteFixture(t)
			config := suspensionConfig(now)
			end := now.Add(2 * time.Second)
			observed := now
			switch boundary {
			case "freshness":
				observed = end.Add(-observability.FreshFor)
			case "cycle":
				config.Provider.CycleEnd = end
			case "service":
				config.Provider.ExpiresAt = &end
			}
			if _, err := s.ConfigureNodeObservations("transit-node", config); err != nil {
				t.Fatal(err)
			}
			if _, err := s.RecordNodeProviderStatement("transit-node", observability.StatementInput{CycleID: "cycle", UsedBytes: 1, ObservedAt: observed, Reference: "synthetic review evidence"}, "operator", now); err != nil {
				t.Fatal(err)
			}
			decision, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "clipped"), now)
			if err != nil || !decision.Allowed || !decision.ExpiresAt.Equal(end) {
				t.Fatalf("actual lease not clipped: %+v %v", decision, err)
			}
		})
	}
}

func TestProviderSuspensionReviewSettlesPositiveDeniedRenewalAndFinal(t *testing.T) {
	s, scope, now, _, _ := providerRouteFixture(t)
	req := admissionRequest("entry1", "192.0.2.1", "positive-settlement")
	decision, err := s.AcquireAdmission(scope, req, now)
	if err != nil || !decision.Allowed {
		t.Fatal(decision, err)
	}
	if _, err = s.ConfigureNodeObservations("transit-node", suspensionConfig(now)); err != nil {
		t.Fatal(err)
	}
	req.AdmittedBytes = 7
	decision, err = s.AcquireAdmission(scope, req, now.Add(time.Second))
	if err != nil || decision.Allowed || decision.Reason != "provider-usage-unknown" {
		t.Fatal(decision, err)
	}
	usage, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 7 || usage.WeightedBytes != 7 {
		t.Fatal(usage, err)
	}
	req.AdmittedBytes = 9
	req.Final = true
	decision, err = s.AcquireAdmission(scope, req, now.Add(2*time.Second))
	if err != nil || decision.Allowed || decision.Reason != "presence-closed" {
		t.Fatal(decision, err)
	}
	usage, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 9 || usage.WeightedBytes != 9 {
		t.Fatal(usage, err)
	}
	decision, err = s.AcquireAdmission(scope, req, now.Add(3*time.Second))
	if err != nil || decision.Reason != "presence-closed" {
		t.Fatal(decision, err)
	}
	usage, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 9 {
		t.Fatal(usage, err)
	}
}
