package store_test

import (
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// These public counter paths must update an already warm admission window, not
// rely on the next admission being the first canonical reconstruction.
func TestUsageProjectionPublicWarmCounterIngestion(t *testing.T) {
	t.Run("counter-deltas-and-provider-replay", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
		binding := store.MeterBinding{ID: "counter", InstanceID: scope.InstanceID, SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: "entry_payload"}
		if err := s.SetMeterBinding(binding); err != nil {
			t.Fatal(err)
		}
		sample := store.CounterSample{SampleID: "sample", CounterEpoch: "boot", SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: binding.MeasurementLayer, CumulativeBytes: 10, ObservedAt: now}
		installZeroBaseline(t, s, scope.InstanceID, sample)
		batch := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: "payload", Sequence: 1, Digest: "one", Samples: []store.CounterSample{sample}}
		for i := 0; i < 2; i++ {
			if err := s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
		}
		usage, err := s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 10 || usage.WeightedBytes != 10 {
			t.Fatalf("initial and replay %+v: %v", usage, err)
		}
		projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
		batch.Sequence = 2
		batch.Digest = "two"
		batch.Samples[0].SampleID = "next"
		batch.Samples[0].CumulativeBytes = 15
		batch.Samples[0].ObservedAt = now.Add(time.Second)
		if err := s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatal(err)
		}
		projectionAssertRemaining(t, s, scope, now.Add(time.Second), time.Time{}, time.Time{}, 2)
		binding.ID = "provider"
		binding.MeasurementLayer = "provider_in_out"
		if err := s.SetMeterBinding(binding); err != nil {
			t.Fatal(err)
		}
		sample.MeasurementLayer = binding.MeasurementLayer
		sample.CumulativeBytes = 70
		installZeroBaseline(t, s, scope.InstanceID, sample)
		batch.StreamEpoch = "provider"
		batch.Sequence = 1
		batch.Digest = "provider"
		batch.Samples = []store.CounterSample{sample}
		for i := 0; i < 2; i++ {
			if err := s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
		}
		usage, err = s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 15 || usage.WeightedBytes != 15 || usage.ProviderBytes != 70 {
			t.Fatalf("provider separation %+v: %v", usage, err)
		}
		projectionAssertRemaining(t, s, scope, now.Add(time.Second), time.Time{}, time.Time{}, 3)
	})
	t.Run("automatic-baseline-does-not-invent-usage", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		if err := s.Put("ledger", "existing", projectionRecord("account", 11, 7, service.RateScale, now.Add(-time.Minute))); err != nil {
			t.Fatal(err)
		}
		projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
		binding := store.MeterBinding{ID: "counter", InstanceID: scope.InstanceID, SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: "entry_payload"}
		if err := s.SetMeterBinding(binding); err != nil {
			t.Fatal(err)
		}
		batch := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: "payload", Sequence: 1, Digest: "unknown-baseline", Samples: []store.CounterSample{{SampleID: "first", CounterEpoch: "boot", SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: binding.MeasurementLayer, CumulativeBytes: 100, ObservedAt: now}}}
		if err := s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatal(err)
		}
		usage, err := s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 11 {
			t.Fatalf("baseline fabricated charge %+v: %v", usage, err)
		}
		for i := 0; i < 2; i++ {
			if err := s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
		}
		projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
		batch.Sequence = 2
		batch.Digest = "measured"
		batch.Samples[0].SampleID = "next"
		batch.Samples[0].CumulativeBytes = 130
		batch.Samples[0].ObservedAt = now.Add(time.Second)
		if err := s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatal(err)
		}
		usage, err = s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 41 || usage.WeightedBytes != 41 {
			t.Fatalf("known delta %+v: %v", usage, err)
		}
		projectionAssertRemaining(t, s, scope, now.Add(time.Second), time.Time{}, time.Time{}, 2)
	})
	t.Run("admission-budget-snapshot-is-not-a-second-charge", func(t *testing.T) {
		s, _, _, scope, now := admissionFixture(t)
		finiteAdmissionPlan(t, s, 100)
		request := admissionRequest("entry1", "192.0.2.80", "measured-flow")
		if got, err := s.AcquireAdmission(scope, request, now); err != nil || !got.Allowed {
			t.Fatalf("initial admission %+v: %v", got, err)
		}
		request.AdmittedBytes = 20
		request.Final = true
		if got, err := s.AcquireAdmission(scope, request, now.Add(time.Second)); err != nil || got.Reason != "presence-closed" {
			t.Fatalf("settlement %+v: %v", got, err)
		}
		projectionAssertRemaining(t, s, scope, now.Add(time.Second), time.Time{}, time.Time{}, 0)
		binding := store.MeterBinding{ID: "managed", InstanceID: scope.InstanceID, SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
		if err := s.SetMeterBinding(binding); err != nil {
			t.Fatal(err)
		}
		batch := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: "managed", Sequence: 1, Digest: "observed", Samples: []store.CounterSample{{SampleID: "first", CounterEpoch: "boot", SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: binding.MeasurementLayer, LedgerMode: binding.LedgerMode, CumulativeBytes: 20, ObservedAt: now.Add(time.Second)}}}
		for i := 0; i < 2; i++ {
			if err := s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
		}
		usage, err := s.Usage("account", time.Time{}, time.Time{})
		if err != nil || usage.RawBytes != 20 || usage.WeightedBytes != 20 {
			t.Fatalf("snapshot double charge %+v: %v", usage, err)
		}
		projectionAssertRemaining(t, s, scope, now.Add(time.Second), time.Time{}, time.Time{}, 1)
	})
}
