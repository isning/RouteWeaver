package store_test

import (
	"context"
	"database/sql"
	"errors"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Authenticated canonical ciphertext may be replayed without knowing the key.
// A currently replaced fence cannot authorize warm current-cycle quota merely
// because all expected trigger names and generation counters still exist.
func TestUsageProjectionChangedCanonicalTriggersDenyQuotaAndRecoverOnReopen(t *testing.T) {
	for _, operation := range []string{"INSERT", "UPDATE"} {
		t.Run(operation, func(t *testing.T) {
			s, path, key, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			if err := s.Put("ledger", "a", projectionRecord("account", 7, 0, service.RateScale, now)); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var replay []byte
			want := int64(11)
			trigger := "usage_ledger_insert"
			if operation == "INSERT" {
				if err = s.Put("ledger", "b", projectionRecord("account", 4, 0, service.RateScale, now)); err != nil {
					t.Fatal(err)
				}
				if err = db.QueryRow(`SELECT data FROM records WHERE kind='ledger' AND id='b'`).Scan(&replay); err != nil {
					t.Fatal(err)
				}
				if err = s.Remove("ledger", "b"); err != nil {
					t.Fatal(err)
				}
			} else {
				want = 7
				trigger = "usage_ledger_update"
				if err = db.QueryRow(`SELECT data FROM records WHERE kind='ledger' AND id='a'`).Scan(&replay); err != nil {
					t.Fatal(err)
				}
				if err = s.Put("ledger", "a", projectionRecord("other", 7, 0, service.RateScale, now)); err != nil {
					t.Fatal(err)
				}
			}
			warm := admissionRequest("entry1", "192.0.2.80", "warm")
			if got, err := s.AcquireAdmission(scope, warm, now); err != nil || !got.Allowed {
				t.Fatal(got, err)
			}
			warm.Final = true
			if _, err = s.AcquireAdmission(scope, warm, now); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(`DROP TRIGGER ` + trigger + `; CREATE TRIGGER ` + trigger + ` AFTER ` + operation + ` ON records BEGIN SELECT 1; END`); err != nil {
				t.Fatal(err)
			}
			if operation == "INSERT" {
				_, err = db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','b',?)`, replay)
			} else {
				_, err = db.Exec(`UPDATE records SET data=? WHERE kind='ledger' AND id='a'`, replay)
			}
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := s.Usage("account", time.Time{}, time.Time{})
			if err != nil || canonical.RawBytes != want {
				t.Fatal(canonical, err)
			}
			got, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.80", "must-deny"), now.Add(time.Second))
			if err == nil || got.Allowed || got.ByteBudget != nil {
				budget := uint64(0)
				if got.ByteBudget != nil {
					budget = *got.ByteBudget
				}
				t.Fatalf("untrusted trigger granted stale quota: budget=%d canonical remaining=%d, %+v err=%v canonical=%+v", budget, 100-want, got, err, canonical)
			}
			page, err := s.NotificationInputPageWithBudget(context.Background(), "", 100, now, store.NotificationColdBudget{Rows: 10, Bytes: 4096})
			if err == nil || errors.Is(err, store.ErrNotificationRebuildPending) {
				t.Fatalf("untrusted trigger advertised completed/pending usage: %+v %v", page, err)
			}
			if err = s.Put("ledger", "blocked", projectionRecord("account", 3, 0, service.RateScale, now)); err == nil {
				t.Fatal("normal write blessed modified trigger")
			}
			var record store.MeterRecord
			if err = s.Get("ledger", "blocked", &record); err != store.ErrNotFound {
				t.Fatal("failed mutation committed", err)
			}
			if err = s.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			got, err = reopened.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.80", "after-reopen"), now.Add(2*time.Second))
			if err != nil || !got.Allowed || got.ByteBudget == nil || *got.ByteBudget != uint64(100-want) {
				t.Fatalf("reopen not exact: %+v %v wantbudget%d", got, err, 100-want)
			}
		})
	}
}
