package store_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

// The historical Usage reducer is the public oracle. Admission must grant the
// exact remaining bytes, not merely reach the same allow/deny result.
func projectionAssertRemaining(t *testing.T, s *store.Store, scope store.AdmissionScope, now time.Time, start, end time.Time, serial int) {
	t.Helper()
	projectionAssertAccountRemaining(t, s, scope, now, start, end, serial, "account", "entry1")
}

func projectionAssertAccountRemaining(t *testing.T, s *store.Store, scope store.AdmissionScope, now, start, end time.Time, serial int, account, entry string) {
	t.Helper()
	usage, err := s.Usage(account, start, end)
	if err != nil {
		t.Fatal(err)
	}
	finiteAdmissionPlan(t, s, usage.WeightedBytes+7)
	in := admissionRequest(entry, "192.0.2.80", fmt.Sprintf("projection-%s-%d", account, serial))
	got, err := s.AcquireAdmission(scope, in, now)
	if err != nil || !got.Allowed || got.ByteBudget == nil || *got.ByteBudget != 7 {
		t.Fatalf("canonical %+v; admission %+v: %v", usage, got, err)
	}
	in.Final = true
	if closed, err := s.AcquireAdmission(scope, in, now); err != nil || closed.Reason != "presence-closed" {
		t.Fatalf("close %+v: %v", closed, err)
	}
}

func projectionRecord(owner string, raw, provider, micros int64, at time.Time) store.MeterRecord {
	return store.MeterRecord{MeterBatch: store.MeterBatch{UserID: owner, RouteID: "route", MeterID: "synthetic", Epoch: "epoch", Sequence: 1, RawBytes: raw, ProviderBytes: provider, ObservedAt: at}, RateMicros: micros, WeightedBytes: 999, RecordedAt: at.Add(time.Hour)}
}

func TestUsageProjectionPublicMutationDifferential(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	other, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	// Deliberately misleading per-record WeightedBytes catches summing rounded rows.
	for i := 0; i < 3; i++ {
		if err := s.Put("ledger", fmt.Sprintf("fraction-%d", i), projectionRecord("account", 1, 2, 333333, now)); err != nil {
			t.Fatal(err)
		}
	}
	totals, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || totals.RawBytes != 3 || totals.ProviderBytes != 6 || totals.WeightedBytes != 1 {
		t.Fatalf("fractional example %+v: %v", totals, err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	rng := rand.New(rand.NewSource(5274))
	present := map[string]bool{}
	for i := 1; i <= 48; i++ {
		id := fmt.Sprintf("mutable-%d", rng.Intn(7))
		writer, reader := s, other
		if i%2 == 0 {
			writer, reader = other, s
		}
		if present[id] && i%4 == 0 {
			err = writer.Remove("ledger", id)
			delete(present, id)
		} else {
			owner := "account"
			if i%3 == 0 {
				owner = "unrelated"
			}
			observed := now.Add(time.Duration(rng.Intn(120)-60) * time.Second)
			record := projectionRecord(owner, int64(rng.Intn(29)), int64(rng.Intn(31)), int64(rng.Intn(2000001)), observed)
			if i%5 == 0 {
				err = writer.UpdateRecords("ledger", id, func(json.RawMessage) ([]store.RecordWrite, error) {
					return []store.RecordWrite{{Kind: "ledger", ID: id, Value: record}}, nil
				})
			} else {
				err = writer.Put("ledger", id, record)
			}
			present[id] = true
		}
		if err != nil {
			t.Fatalf("operation %d: %v", i, err)
		}
		projectionAssertRemaining(t, reader, scope, now, time.Time{}, time.Time{}, i)
	}
}

func TestUsageProjectionPublicOverflowRecoversAfterDeletion(t *testing.T) {
	for _, field := range []string{"raw", "provider", "weighted"} {
		t.Run(field, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
			large := projectionRecord("account", math.MaxInt64, 0, 0, now)
			tiny := projectionRecord("account", 1, 0, 0, now)
			if field == "provider" {
				large.RawBytes = 0
				large.ProviderBytes = math.MaxInt64
				tiny.RawBytes = 0
				tiny.ProviderBytes = 1
			}
			if field == "weighted" {
				large.RawBytes = math.MaxInt64 / 2
				large.RateMicros = 2 * service.RateScale
				tiny.RateMicros = 2 * service.RateScale
			}
			if err := s.Put("ledger", "large", large); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("ledger", "tiny", tiny); err != nil {
				t.Fatalf("canonical insert must not reject aggregate overflow: %v", err)
			}
			if _, err := s.Usage("account", time.Time{}, time.Time{}); err == nil {
				t.Fatal("historical usage accepted overflow")
			}
			if got, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.80", "overflow"), now); err == nil {
				t.Fatalf("admission accepted overflow: %+v", got)
			}
			if err := s.Remove("ledger", "large"); err != nil {
				t.Fatalf("delete must recover overflowing total: %v", err)
			}
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
		})
	}
}

func TestUsageProjectionPublicDirtyDeleteCannotBeMaskedByTrackedWrite(t *testing.T) {
	s, path, _, scope, now := admissionFixture(t)
	if err := s.Put("ledger", "old", projectionRecord("account", 30, 40, service.RateScale, now)); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	// Intentional fault injection: a missed legacy writer bypasses Store helpers.
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`DELETE FROM records WHERE kind='ledger' AND id='old'`); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "new", projectionRecord("account", 11, 13, service.RateScale, now)); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
}

func TestUsageProjectionPublicDeniedRenewalCommitsSettlement(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.80", "settlement")
	if got, err := s.AcquireAdmission(scope, in, now); err != nil || !got.Allowed {
		t.Fatalf("initial %+v: %v", got, err)
	}
	if err := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	in.AdmittedBytes = 40
	if got, err := s.AcquireAdmission(scope, in, now.Add(time.Second)); err != nil || got.Reason != "disabled" {
		t.Fatalf("denied renewal %+v: %v", got, err)
	}
	in.Final = true
	if _, err := s.AcquireAdmission(scope, in, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	usage, err := reopened.Usage("account", time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != 40 {
		t.Fatalf("committed settlement %+v: %v", usage, err)
	}
	projectionAssertRemaining(t, reopened, scope, now.Add(3*time.Second), time.Time{}, time.Time{}, 1)
}

func TestUsageProjectionPublicFutureResetAndBackwardsArrival(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	for i, offset := range []time.Duration{-time.Minute, 0, time.Minute} {
		if err := s.Put("ledger", fmt.Sprintf("timed-%d", i), projectionRecord("account", int64(i+1)*10, 0, service.RateScale, now.Add(offset))); err != nil {
			t.Fatal(err)
		}
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	reset := now.Add(30 * time.Second)
	if err := s.ManualReset("account", "synthetic future boundary", reset); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
	projectionAssertRemaining(t, s, scope, now.Add(40*time.Second), reset, time.Time{}, 2)
	// A late old-window fact changes history but must not charge the new window.
	if err := s.Put("ledger", "late", projectionRecord("account", 50, 0, service.RateScale, now)); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now.Add(41*time.Second), reset, time.Time{}, 3)
	projectionAssertRemaining(t, s, scope, now.Add(-time.Second), time.Time{}, time.Time{}, 4)
}

func TestUsageProjectionPublicAtomicBatchRollback(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	record := projectionRecord("account", 17, 21, service.RateScale, now)
	err := s.CompareAndPutRecords(nil, []store.RecordWrite{{Kind: "ledger", ID: "rolled-back", Value: record}, {Kind: "synthetic", ID: "invalid", Value: make(chan int)}})
	if err == nil {
		t.Fatal("unserializable batch unexpectedly succeeded")
	}
	if err := s.Get("ledger", "rolled-back", &record); err != store.ErrNotFound {
		t.Fatalf("partial canonical write: %v", err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
	if err := s.CompareAndPutRecords(nil, []store.RecordWrite{{Kind: "ledger", ID: "committed", Value: record}}); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 2)
	if err := s.PutImmutable("ledger", "immutable", record); err != nil {
		t.Fatal(err)
	}
	if err := s.PutImmutable("ledger", "immutable", record); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 3)
	if _, err := s.GenerateRecord("ledger", "generated", func(uint64) (any, error) { return record, nil }); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 4)
	if err := s.PutWithToken("ledger", "token-written", record, "synthetic", "", "digest", "token-written"); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 5)
	if err := s.PutWithToken("ledger", "token-rollback", record, "synthetic", "", "digest", "token-rollback"); err == nil {
		t.Fatal("duplicate token must roll back ledger insertion")
	}
	if err := s.Get("ledger", "token-rollback", &record); err != store.ErrNotFound {
		t.Fatalf("failed token write left ledger: %v", err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 6)
	if err := s.CompareAndPutWithToken("ledger", "token-written", record, projectionRecord("account", 2, 3, service.RateScale, now), "synthetic", "digest", "next", "token-written"); err != nil {
		t.Fatal(err)
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 7)
}

func TestUsageProjectionPublicFiniteHalfOpenWindows(t *testing.T) {
	for _, mode := range []string{"monthly", "anniversary", "fixed-days"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			cycle := service.CyclePolicy{Mode: mode, Day: 31, Days: 7, Anchor: time.Date(now.Year()-1, 1, 31, 0, 0, 0, 0, service.DefaultLocation), Timezone: "UTC+8"}
			window, err := cycle.Window(now)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Put("entitlements", "account", service.Entitlement{UserID: "account", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: cycle}); err != nil {
				t.Fatal(err)
			}
			for i, at := range []time.Time{window.Start.Add(-time.Nanosecond), window.Start, window.NextReset.Add(-time.Nanosecond), *window.NextReset} {
				if err := s.Put("ledger", fmt.Sprintf("boundary-%d", i), projectionRecord("account", int64(i+1)*10, 0, service.RateScale, at)); err != nil {
					t.Fatal(err)
				}
			}
			usage, err := s.Usage("account", window.Start, *window.NextReset)
			if err != nil || usage.RawBytes != 50 {
				t.Fatalf("half-open reference %+v: %v", usage, err)
			}
			projectionAssertRemaining(t, s, scope, now, window.Start, *window.NextReset, 0)
			// Overwriting a formerly included row with an out-of-window observation must subtract it.
			if err := s.Put("ledger", "boundary-1", projectionRecord("account", 20, 0, service.RateScale, *window.NextReset)); err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, s, scope, now, window.Start, *window.NextReset, 1)
		})
	}
}

func TestUsageProjectionPublicConcurrentMeterReplay(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	other, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	var expected int64
	for sequence := 1; sequence <= 16; sequence++ {
		start := make(chan struct{})
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for i, writer := range []*store.Store{s, other} {
			wg.Add(1)
			go func(i int, writer *store.Store) {
				defer wg.Done()
				<-start
				results <- writer.RecordMeter(store.MeterBatch{UserID: "account", RouteID: "route", MeterID: "racing", Epoch: "epoch", Sequence: uint64(sequence), RawBytes: int64(i + 1), ProviderBytes: 3, ObservedAt: now})
			}(i, writer)
		}
		close(start)
		wg.Wait()
		close(results)
		successes := 0
		for err := range results {
			if err == nil {
				successes++
			}
		}
		if successes != 1 {
			t.Fatalf("conflicting sequence %d accepted by %d writers", sequence, successes)
		}
		var accepted store.MeterRecord
		if err := s.Get("ledger", fmt.Sprintf("account:racing:epoch:%d", sequence), &accepted); err != nil {
			t.Fatal(err)
		}
		expected += accepted.RawBytes
		projectionAssertRemaining(t, other, scope, now, time.Time{}, time.Time{}, sequence)
	}
	totals, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || totals.RawBytes != expected || totals.ProviderBytes != 48 {
		t.Fatalf("concurrent meter totals %+v expected raw %d: %v", totals, expected, err)
	}
}

func TestUsageProjectionPublicDirtyInvalidatesOtherAccounts(t *testing.T) {
	s, path, _, scope, now := admissionFixture(t)
	if err := s.PutUser(domain.User{ID: "second", Name: "Second", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("entitlements", "second", service.Entitlement{UserID: "second", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("managed-endpoints", "entry-second", domain.ManagedEndpoint{ID: "entry-second", InstanceID: scope.InstanceID}); err != nil {
		t.Fatal(err)
	}
	if err := s.TenantPut("second", "platform-entries", "entry-second", map[string]any{"id": "entry-second", "userId": "second", "routeId": "route", "credentialVersion": "v1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEntryAdmissionBinding(store.EntryAdmissionBinding{ID: "entry-second", InstanceID: scope.InstanceID, EntryID: "entry-second", SubjectID: "subject", UserID: "second", RouteID: "route", GrantID: "entry-second", CredentialVersion: "v1"}); err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{"account", "second"} {
		if err := s.Put("ledger", account, projectionRecord(account, 23, 11, service.RateScale, now)); err != nil {
			t.Fatal(err)
		}
	}
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
	projectionAssertAccountRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0, "second", "entry-second")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DELETE FROM records WHERE kind='ledger'`); err != nil {
		t.Fatal(err)
	}
	// Rebuilding the first account must not mark the second stale window clean.
	projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
	projectionAssertAccountRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1, "second", "entry-second")
}

func TestUsageProjectionPublicBypassedCiphertextWrites(t *testing.T) {
	for _, operation := range []string{"insert", "update"} {
		t.Run(operation, func(t *testing.T) {
			s, path, _, scope, now := admissionFixture(t)
			if err := s.Put("ledger", "bypassed", projectionRecord("account", 29, 31, service.RateScale, now)); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var saved []byte
			if err := db.QueryRow(`SELECT data FROM records WHERE kind='ledger' AND id='bypassed'`).Scan(&saved); err != nil {
				t.Fatal(err)
			}
			if operation == "insert" {
				err = s.Remove("ledger", "bypassed")
			} else {
				err = s.Put("ledger", "bypassed", projectionRecord("account", 3, 5, service.RateScale, now))
			}
			if err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
			// Restore an authentic earlier canonical payload without the mutation helper.
			// This simulates a legacy writer, not an adversarial rollback guarantee.
			if operation == "insert" {
				_, err = db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','bypassed',?)`, saved)
			} else {
				_, err = db.Exec(`UPDATE records SET data=? WHERE kind='ledger' AND id='bypassed'`, saved)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Put("ledger", "normal-after-bypass", projectionRecord("account", 7, 9, service.RateScale, now)); err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
		})
	}
}
