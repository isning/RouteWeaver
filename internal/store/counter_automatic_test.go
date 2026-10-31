package store_test

import (
	"bytes"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestCounterAutomaticallyStartsAtFirstObservedValue(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{27}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true, QuotaBytes: 1000}); err != nil {
		t.Fatal(err)
	}
	binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	sample := store.CounterSample{SampleID: "first", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: time.Now().UTC().Add(-time.Minute)}
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "first", Samples: []store.CounterSample{sample}}
	for n := 0; n < 2; n++ {
		if err = s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatalf("automatic baseline/replay: %v", err)
		}
	}
	if usage, err := s.Usage("u", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 0 {
		t.Fatalf("unknown history charged: %+v %v", usage, err)
	}
	if held, err := s.HasAccountingHold("u"); err != nil || held {
		t.Fatalf("automatic recovery blocked access: %v %v", held, err)
	}
	if pending, err := s.PendingCounterBatches("i"); err != nil || len(pending) != 0 {
		t.Fatalf("manual recovery required: %+v %v", pending, err)
	}
	var result store.BaselineResolution
	if err = s.Get("meter-baseline-resolutions", "i:e:main:1", &result); err != nil || len(result.Samples) != 1 || result.Samples[0].UnattributedBytes != 100 {
		t.Fatalf("unassigned history missing: %+v %v", result, err)
	}
	if history, err := s.List("meter-pending-history"); err != nil || len(history) != 1 {
		t.Fatalf("original evidence/replay: %d %v", len(history), err)
	}
	if audit, err := s.List("audit"); err != nil || len(audit) != 1 {
		t.Fatalf("audit/replay: %d %v", len(audit), err)
	}
	batch.Sequence = 2
	batch.Digest = "next"
	batch.Samples[0].SampleID = "next"
	batch.Samples[0].CumulativeBytes = 130
	batch.Samples[0].ObservedAt = sample.ObservedAt.Add(time.Second)
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	if usage, err := s.Usage("u", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 30 {
		t.Fatalf("known next interval: %+v %v", usage, err)
	}
	var user domain.User
	if err = s.Get("users", "u", &user); err != nil || user.QuotaBytes != 1000 {
		t.Fatalf("quota changed: %+v %v", user, err)
	}
}

func TestCounterAutomaticRecoveryValidatesWholeBatchAndLegacyReplay(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "db")
			s, err := store.Open(path, bytes.Repeat([]byte{28}, 32))
			if err != nil {
				t.Fatal(err)
			}
			defer func() { s.Close() }()
			if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true, QuotaBytes: 1000}); err != nil {
				t.Fatal(err)
			}
			binding := store.MeterBinding{ID: "b", InstanceID: "i", SubjectID: "u", UserID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload"}
			if err = s.SetMeterBinding(binding); err != nil {
				t.Fatal(err)
			}
			sample := store.CounterSample{SampleID: "first", CounterEpoch: "boot", SubjectID: "u", RouteID: "r", PolicyRevision: "p", CycleID: "c", MeasurementLayer: "entry_payload", CumulativeBytes: 100, ObservedAt: time.Now().UTC().Add(-time.Minute)}
			batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "first", Samples: []store.CounterSample{sample}}
			if legacy {
				seedLegacyCounterPending(t, s, batch, "u")
			}
			// An unrelated unresolved hold must never be cleared by this receipt.
			if err = s.Put("accounting-holds", "unrelated", store.AccountingHold{UserID: "u", ReceiptID: "other-receipt", Reason: "unresolved"}); err != nil {
				t.Fatal(err)
			}
			poison := sample
			poison.SampleID = "poison"
			poison.SubjectID = "unbound"
			invalid := batch
			invalid.Samples = []store.CounterSample{sample, poison}
			if err = s.AcceptCounterBatch(invalid, invalid); err == nil {
				t.Fatal("invalid later sample bypassed validation")
			}
			for _, kind := range []string{"ledger", "counter-cursors", "meter-receipts", "meter-baseline-resolutions", "audit"} {
				rows, e := s.List(kind)
				if e != nil || len(rows) != 0 {
					t.Fatalf("partial %s: %d %v", kind, len(rows), e)
				}
			}
			if legacy {
				pending, e := s.PendingCounterBatches("i")
				if e != nil || len(pending) != 1 {
					t.Fatalf("legacy pending lost %+v %v", pending, e)
				}
			}
			if err = s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
			// Restart the store before retrying the same durable outbox record.
			if err = s.Close(); err != nil {
				t.Fatal(err)
			}
			s, err = store.Open(path, bytes.Repeat([]byte{28}, 32))
			if err != nil {
				t.Fatal(err)
			}
			if err = s.AcceptCounterBatch(batch, batch); err != nil {
				t.Fatal(err)
			}
			if rows, e := s.List("audit"); e != nil || len(rows) != 1 {
				t.Fatalf("duplicate recovery audit %d %v", len(rows), e)
			}
			if pending, e := s.PendingCounterBatches("i"); e != nil || len(pending) != 0 {
				t.Fatalf("manual pending retained %+v %v", pending, e)
			}
			var hold store.AccountingHold
			if e := s.Get("accounting-holds", "unrelated", &hold); e != nil {
				t.Fatalf("unrelated hold cleared %v", e)
			}
			if e := s.Get("accounting-holds", "u:i:e:main:1", &hold); e != store.ErrNotFound {
				t.Fatalf("recovered legacy hold retained %v", e)
			}
			if usage, e := s.Usage("u", time.Time{}, time.Time{}); e != nil || usage.RawBytes != 0 {
				t.Fatalf("legacy unknown charge %+v %v", usage, e)
			}
			conflicting := batch
			conflicting.Digest = "conflict"
			if e := s.AcceptCounterBatch(conflicting, conflicting); e == nil {
				t.Fatal("conflicting receipt accepted")
			}
			batch.Sequence = 2
			batch.Digest = "next"
			batch.Samples[0].CumulativeBytes = 125
			batch.Samples[0].ObservedAt = sample.ObservedAt.Add(time.Second)
			if e := s.AcceptCounterBatch(batch, batch); e != nil {
				t.Fatal(e)
			}
			if usage, e := s.Usage("u", time.Time{}, time.Time{}); e != nil || usage.RawBytes != 25 {
				t.Fatalf("legacy continuation %+v %v", usage, e)
			}
		})
	}
}

func TestCounterExplicitRestartPreservesKnownUsageAndRejectsRegression(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{29}, 32))
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
	installZeroBaseline(t, s, "i", sample)
	batch := store.CounterBatch{InstanceID: "i", EnrollmentEpoch: "e", StreamEpoch: "main", Sequence: 1, Digest: "first", Samples: []store.CounterSample{sample}}
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	batch.Sequence = 2
	batch.Digest = "restart"
	batch.Samples[0].CumulativeBytes = 5
	batch.Samples[0].ObservedAt = sample.ObservedAt.Add(time.Second)
	if err = s.AcceptCounterBatch(batch, batch); err == nil {
		t.Fatal("same epoch decrease treated as restart")
	}
	batch.Samples[0].CounterEpoch = "new-boot"
	for i := 0; i < 2; i++ {
		if err = s.AcceptCounterBatch(batch, batch); err != nil {
			t.Fatal(err)
		}
	}
	batch.Sequence = 3
	batch.Digest = "after-restart"
	batch.Samples[0].CumulativeBytes = 12
	batch.Samples[0].ObservedAt = sample.ObservedAt.Add(2 * time.Second)
	if err = s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatal(err)
	}
	if usage, e := s.Usage("u", time.Time{}, time.Time{}); e != nil || usage.RawBytes != 107 {
		t.Fatalf("restart charged unknown traffic %+v %v", usage, e)
	}
	var result store.BaselineResolution
	if e := s.Get("meter-baseline-resolutions", "i:e:main:2", &result); e != nil || len(result.Samples) != 1 || result.Samples[0].UnattributedBytes != 5 {
		t.Fatalf("restart evidence %+v %v", result, e)
	}
}
