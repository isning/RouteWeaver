package store_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestCounterIngestionIsAtomicReplaySafeAndSeparatesProvider(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{12}, 32))
	defer s.Close()
	s.PutUser(domain.User{ID: "u", Name: "User", Enabled: false, QuotaBytes: 1})
	now := time.Now().UTC()
	s.SetRate(service.Rate{ID: "rate2", RouteID: "r", Micros: 2000000, EffectiveAt: now.Add(-time.Hour)})
	binding := store.MeterBinding{ID: "binding1", InstanceID: "instance1", SubjectID: "native-user", UserID: "u", RouteID: "r", PolicyRevision: "p1", CycleID: "cycle1", MeasurementLayer: "entry_payload", RateID: "rate2"}
	if e := s.SetMeterBinding(binding); e != nil {
		t.Fatal(e)
	}
	sample := store.CounterSample{SampleID: "s1", CounterEpoch: "boot1", SubjectID: binding.SubjectID, RouteID: "r", PolicyRevision: "p1", CycleID: "cycle1", MeasurementLayer: "entry_payload", CumulativeBytes: 10, ObservedAt: now}
	installZeroBaseline(t, s, "instance1", sample)
	batch := store.CounterBatch{InstanceID: "instance1", EnrollmentEpoch: "e1", StreamEpoch: "stream1", Sequence: 1, Digest: "one", Samples: []store.CounterSample{sample}}
	poison := sample
	poison.SampleID = "s2"
	poison.SubjectID = "unbound"
	batch.Samples = append(batch.Samples, poison)
	if e := s.AcceptCounterBatch(batch, batch); e == nil {
		t.Fatal("unbound source accepted")
	}
	usage, _ := s.Usage("u", time.Time{}, now.Add(time.Hour))
	if usage.RawBytes != 0 {
		t.Fatal("partial failed batch charged")
	}
	batch.Samples = batch.Samples[:1]
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	batch.Sequence = 2
	batch.Digest = "two"
	batch.Samples[0].SampleID = "s3"
	batch.Samples[0].CumulativeBytes = 15
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	provider := binding
	provider.ID = "provider1"
	provider.MeasurementLayer = "provider_in_out"
	provider.RateID = ""
	s.SetMeterBinding(provider)
	providerSample := sample
	providerSample.MeasurementLayer = "provider_in_out"
	installZeroBaseline(t, s, "instance1", providerSample)
	batch.Sequence = 3
	batch.Digest = "three"
	batch.Samples[0].SampleID = "s4"
	batch.Samples[0].MeasurementLayer = "provider_in_out"
	batch.Samples[0].CumulativeBytes = 70
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("u", time.Time{}, now.Add(time.Hour))
	if e != nil || usage.RawBytes != 15 || usage.WeightedBytes != 30 || usage.ProviderBytes != 70 {
		t.Fatalf("mixed accounting %+v %v", usage, e)
	}
	batch.Sequence = 4
	batch.Digest = "four"
	batch.Samples[0].SampleID = "s5"
	batch.Samples[0].CumulativeBytes = 60
	if e = s.AcceptCounterBatch(batch, batch); e == nil {
		t.Fatal("implicit counter reset accepted")
	}
}
func TestCounterCursorDoesNotResetOnBillingCycleChange(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{13}, 32))
	defer s.Close()
	s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true})
	now := time.Now().UTC()
	binding := store.MeterBinding{ID: "b1", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c1", MeasurementLayer: "entry_payload"}
	s.SetMeterBinding(binding)
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "s", Sequence: 1, Digest: "one", Samples: []store.CounterSample{{SampleID: "sample1", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c1", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: now}}}
	installZeroBaseline(t, s, "i", batch.Samples[0])
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	binding.ID = "b2"
	binding.CycleID = "c2"
	binding.EffectiveAt = now
	s.SetMeterBinding(binding)
	batch.Sequence = 2
	batch.Digest = "two"
	batch.Samples[0].CycleID = "c2"
	batch.Samples[0].SampleID = "sample2"
	batch.Samples[0].CumulativeBytes = 120
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	usage, e := s.Usage("u", time.Time{}, now.Add(time.Hour))
	if e != nil || usage.RawBytes != 120 {
		t.Fatalf("cycle rollover double-charged cumulative bytes: %+v %v", usage, e)
	}
}

func TestCounterPolicyBoundaryAutomaticallyContinuesWithoutGuessing(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{14}, 32))
	defer s.Close()
	s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true})
	now := time.Now().UTC()
	before := now.Add(-2 * time.Minute)
	boundary := now.Add(-time.Minute)
	binding := store.MeterBinding{ID: "b1", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p1", CycleID: "c1", MeasurementLayer: "entry_payload"}
	s.SetMeterBinding(binding)
	sample := store.CounterSample{SampleID: "sample1", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p1", CycleID: "c1", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: before}
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "one", Samples: []store.CounterSample{sample}}
	installZeroBaseline(t, s, "i", batch.Samples[0])
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	binding.ID = "b2"
	binding.PolicyRevision = "p2"
	binding.EffectiveAt = boundary
	s.SetMeterBinding(binding)
	batch.Sequence = 2
	batch.Digest = "two"
	batch.Samples[0].SampleID = "sample2"
	batch.Samples[0].PolicyRevision = "p2"
	batch.Samples[0].CumulativeBytes = 150
	batch.Samples[0].ObservedAt = now
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	usage, _ := s.Usage("u", time.Time{}, time.Time{})
	if usage.RawBytes != 100 {
		t.Fatal("fabricated split charged")
	}
	var result store.BaselineResolution
	if e := s.Get("meter-baseline-resolutions", "i:e:main:2", &result); e != nil || len(result.Samples) != 1 || result.Samples[0].UnattributedBytes != 50 {
		t.Fatalf("lost interval %+v %v", result, e)
	}
	batch.Sequence = 3
	batch.Digest = "three"
	batch.Samples[0].CumulativeBytes = 170
	batch.Samples[0].ObservedAt = now.Add(time.Second)
	if e := s.AcceptCounterBatch(batch, batch); e != nil {
		t.Fatal(e)
	}
	usage, _ = s.Usage("u", time.Time{}, time.Time{})
	if usage.RawBytes != 120 {
		t.Fatalf("known delta lost %+v", usage)
	}
	if held, e := s.HasAccountingHold("u"); e != nil || held {
		t.Fatalf("unexpected hold %v %v", held, e)
	}
}

// A stale cycle ID must not cause an interval that spans an actual automatic or
// manual reset to be entirely assigned to the cycle at the end of the sample.
func TestCounterCalendarAndManualBoundaryNeedExactObservation(t *testing.T) {
	for _, kind := range []string{"calendar", "manual"} {
		for _, proven := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/proven=%v", kind, proven), func(t *testing.T) {
				s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{15}, 32))
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true}); err != nil {
					t.Fatal(err)
				}
				boundary := time.Date(2026, 10, 1, 0, 0, 0, 0, service.DefaultLocation)
				before, after := boundary.Add(-time.Minute), boundary.Add(time.Minute)
				policy := service.CyclePolicy{Mode: "monthly", Day: 1, Anchor: boundary.AddDate(0, -1, 0), Timezone: "UTC+8"}
				if kind == "manual" {
					policy.Mode = "none"
					if err = s.ManualReset("u", "test measured reset", boundary); err != nil {
						t.Fatal(err)
					}
				}
				if err = s.Put("entitlements", "u", service.Entitlement{UserID: "u", StartsAt: policy.Anchor, Cycle: policy}); err != nil {
					t.Fatal(err)
				}
				binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "unchanged", MeasurementLayer: "entry_payload"}
				if err = s.SetMeterBinding(binding); err != nil {
					t.Fatal(err)
				}
				sample := store.CounterSample{SampleID: "baseline", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "unchanged", MeasurementLayer: "entry_payload", ObservedAt: before}
				batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "zero", Samples: []store.CounterSample{sample}}
				if err = s.AcceptCounterBatch(batch, batch); err != nil {
					t.Fatal(err)
				}
				if proven {
					proof := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "boundary", Sequence: 1, Digest: "proof", Samples: []store.CounterSample{sample}}
					proof.Samples[0].SampleID = "proof"
					proof.Samples[0].ObservedAt = boundary
					proof.Samples[0].CumulativeBytes = 20
					if err = s.AcceptCounterBatch(proof, proof); err != nil {
						t.Fatal(err)
					}
				}
				batch.Sequence = 2
				batch.Digest = "after"
				batch.Samples[0].SampleID = "after"
				batch.Samples[0].ObservedAt = after
				batch.Samples[0].CumulativeBytes = 50
				for n := 0; n < 2; n++ {
					if err = s.AcceptCounterBatch(batch, batch); err != nil {
						t.Fatal(err)
					}
				}
				wantPrior, wantCurrent := int64(0), int64(0)
				if proven {
					wantPrior, wantCurrent = 20, 30
				}
				prior, err := s.Usage("u", time.Time{}, boundary)
				if err != nil || prior.RawBytes != wantPrior {
					t.Fatalf("previous cycle %+v %v", prior, err)
				}
				current, err := s.Usage("u", boundary, after.Add(time.Second))
				if err != nil || current.RawBytes != wantCurrent {
					t.Fatalf("new cycle %+v %v", current, err)
				}
				if held, err := s.HasAccountingHold("u"); err != nil || held {
					t.Fatalf("unexpected hold %v %v", held, err)
				}
				batch.Sequence = 3
				batch.Digest = "next"
				batch.Samples[0].ObservedAt = after.Add(time.Second)
				batch.Samples[0].CumulativeBytes = 60
				if err = s.AcceptCounterBatch(batch, batch); err != nil {
					t.Fatal(err)
				}
				current, err = s.Usage("u", boundary, after.Add(time.Minute))
				if err != nil || current.RawBytes != wantCurrent+10 {
					t.Fatalf("next known delta %+v %v", current, err)
				}
			})
		}
	}

}

func TestFirstNonzeroCounterWithProvenZeroBaseline(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{16}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	b := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload"}
	if err = s.SetMeterBinding(b); err != nil {
		t.Fatal(err)
	}
	sample := store.CounterSample{SampleID: "s", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: time.Now().UTC()}
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "first", Samples: []store.CounterSample{sample}}
	proof := batch
	proof.StreamEpoch = "baseline"
	proof.Digest = "zero"
	proof.Samples = []store.CounterSample{sample}
	proof.Samples[0].CumulativeBytes = 0
	proof.Samples[0].ObservedAt = sample.ObservedAt.Add(-time.Minute)
	if err = s.AcceptCounterBatch(proof, proof); err != nil {
		t.Fatal(err)
	}
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	usage, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 100 {
		t.Fatalf("proved initial usage %+v %v", usage, err)
	}
}

func installZeroBaseline(t *testing.T, s *store.Store, instance string, sample store.CounterSample) {
	t.Helper()
	sample.CumulativeBytes = 0
	sample.ObservedAt = sample.ObservedAt.Add(-time.Minute)
	batch := store.CounterBatch{InstanceID: instance, EnrollmentEpoch: "e", StreamEpoch: "zero-" + sample.MeasurementLayer, Sequence: 1, Digest: "zero", Samples: []store.CounterSample{sample}}
	if err := s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
}

func TestOperatorBaselineIsAuditedAndDoesNotChargeUnknownInterval(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	sample := store.CounterSample{SampleID: "s", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: time.Now().UTC().Add(-time.Minute)}
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "first", Samples: []store.CounterSample{sample}}
	seedLegacyCounterPending(t, s, batch, "u")
	pending, err := s.PendingCounterBatches("i")
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending %+v %v", pending, err)
	}
	receipt := pending[0].ReceiptID
	if _, err = s.EstablishCounterBaseline("i", receipt, "stale", "operator", "Begin from known observation"); err != store.ErrConflict {
		t.Fatalf("stale baseline %v", err)
	}
	result, err := s.EstablishCounterBaseline("i", receipt, batch.Digest, "operator", "Begin from known observation")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Samples) != 1 || result.Samples[0].UnattributedBytes != 100 {
		t.Fatalf("lost historical amount %+v", result)
	}
	if _, err = s.EstablishCounterBaseline("other", receipt, batch.Digest, "operator", "Begin from known observation"); err != store.ErrConflict {
		t.Fatalf("cross-instance replay %v", err)
	}
	if _, err = s.EstablishCounterBaseline("i", receipt, batch.Digest, "operator", "Begin from known observation"); err != nil {
		t.Fatal(err)
	}
	if held, err := s.HasAccountingHold("u"); err != nil || !held {
		t.Fatalf("hold cleared before replay %v %v", held, err)
	}
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	if usage, err := s.Usage("u", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 0 {
		t.Fatalf("retroactive charge %+v %v", usage, err)
	}
	if held, err := s.HasAccountingHold("u"); err != nil || held {
		t.Fatalf("resolved hold %v %v", held, err)
	}
	history, err := s.List("meter-pending-history")
	if err != nil || len(history) != 1 {
		t.Fatal("pending evidence erased")
	}
	audit, err := s.List("audit")
	if err != nil || len(audit) != 1 {
		t.Fatal("baseline audit missing or duplicated")
	}
	batch.Sequence = 2
	batch.Digest = "second"
	batch.Samples[0].CumulativeBytes = 130
	batch.Samples[0].ObservedAt = sample.ObservedAt.Add(time.Second)
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	if usage, err := s.Usage("u", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 30 {
		t.Fatalf("new measured interval %+v %v", usage, err)
	}
}

// Seed the persisted pre-upgrade contract, not the new ingestion implementation.
func seedLegacyCounterPending(t *testing.T, s *store.Store, batch store.CounterBatch, user string) {
	t.Helper()
	receipt := fmt.Sprintf("%s:%s:%s:%d", batch.InstanceID, batch.EnrollmentEpoch, batch.StreamEpoch, batch.Sequence)
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	pending := store.PendingCounterBatch{ReceiptID: receipt, Batch: batch, Original: raw, Reason: store.ErrPendingAttribution.Error(), CreatedAt: time.Now().UTC()}
	for _, kind := range []string{"meter-pending", "meter-pending-history"} {
		if err = s.Put(kind, receipt, pending); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Put("accounting-holds", user+":"+receipt, store.AccountingHold{UserID: user, ReceiptID: receipt, Reason: pending.Reason, CreatedAt: pending.CreatedAt}); err != nil {
		t.Fatal(err)
	}
}
