package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"strings"
	"testing"
	"time"
)

func rebuildFixture(t *testing.T) (*Store, time.Time) {
	t.Helper()
	s := projectionTestStore(t)
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	if err := s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true, QuotaBytes: 1000}); err != nil {
		t.Fatal(err)
	}
	return s, now
}
func rebuildRecord(user string, raw, rate int64, at time.Time) MeterRecord {
	return MeterRecord{MeterBatch: MeterBatch{UserID: user, RawBytes: raw, ObservedAt: at}, RateMicros: rate}
}
func TestNotificationColdChunksEventuallyPublishExactCompleteUsage(t *testing.T) {
	s, now := rebuildFixture(t)
	for i := 0; i < 7; i++ {
		if err := s.Put("ledger", fmt.Sprintf("r%d", i), rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	budget := NotificationColdBudget{Rows: 2, Bytes: 4096}
	for step := 0; step < 4; step++ {
		page, err := s.NotificationInputPageWithBudget(context.Background(), "", 100, now, budget)
		if len(page.Users) != 1 {
			t.Fatalf("step %d missing snapshot: %+v %v", step, page, err)
		}
		if step < 3 {
			if err == nil || !page.Users[0].UsageUnknown || page.Users[0].UsedBytes != 0 {
				t.Fatalf("partial exposed: %+v %v", page, err)
			}
		} else if err != nil || page.Users[0].UsageUnknown || page.Users[0].UsedBytes != 4 {
			t.Fatalf("bounded chunks did not converge exactly: %+v %v", page, err)
		}
	}
	raw, err := s.List("ledger")
	if err != nil || len(raw) != 7 {
		t.Fatal("canonical history changed")
	}
}

func rebuildStep(t *testing.T, s *Store, now time.Time, rows int64) (NotificationPage, error) {
	t.Helper()
	return s.NotificationInputPageWithBudget(context.Background(), "", 100, now, NotificationColdBudget{Rows: rows, Bytes: notificationColdBytes})
}
func finishRebuild(t *testing.T, s *Store, now time.Time, rows int64, maxSteps int) NotificationPage {
	t.Helper()
	for i := 0; i < maxSteps; i++ {
		p, err := rebuildStep(t, s, now, rows)
		if err == nil {
			return p
		}
		if !errors.Is(err, ErrNotificationRebuildPending) {
			t.Fatal(err)
		}
	}
	t.Fatal("bounded fixture reconstruction did not complete")
	return NotificationPage{}
}
func assertRebuildMatchesCanonical(t *testing.T, s *Store, page NotificationPage, start, end time.Time) {
	t.Helper()
	for _, u := range page.Users {
		want, err := s.Usage(u.UserID, start, end)
		if err != nil {
			t.Fatal(err)
		}
		if u.UsageUnknown || u.UsedBytes != want.WeightedBytes {
			t.Fatalf("partial/canonical mismatch: %+v want %+v", u, want)
		}
	}
}

func TestUsageRebuildTracksMutationsOnBothSidesOfFrontier(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.PutUser(domain.User{ID: "bob", Name: "Bob", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	p, err := rebuildStep(t, s, now, 2)
	if !errors.Is(err, ErrNotificationRebuildPending) || len(p.Users) != 2 {
		t.Fatal(p, err)
	}
	// a and b are already scanned; c/d/e are not. Move ownership, delete,
	// backdate an insertion behind the frontier and replace an unscanned fact.
	if err = s.Put("ledger", "a", rebuildRecord("bob", 3, 500000, now.Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err = s.Remove("ledger", "b"); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "aa", rebuildRecord("u", 4, 500000, now.Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "c", rebuildRecord("u", 5, 500000, now)); err != nil {
		t.Fatal(err)
	}
	p = finishRebuild(t, s, now, 2, 3)
	assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
	for _, u := range p.Users {
		if u.UserID == "u" && u.UsedBytes != 6 || u.UserID == "bob" && u.UsedBytes != 2 {
			t.Fatal(u)
		}
	}
}

func TestUsageRebuildAdvancesUnderContinuousNormalLedgerWrites(t *testing.T) {
	s, now := rebuildFixture(t)
	for i := 0; i < 7; i++ {
		if err := s.Put("ledger", fmt.Sprintf("m%02d", i), rebuildRecord("u", 1, 333333, now)); err != nil {
			t.Fatal(err)
		}
	}
	for step := 0; step < 10; step++ {
		// Growth is one new tail row per two-row chunk. Already-scanned updates
		// and lower-ID insertions must not force the canonical scan back to zero.
		if err := s.Put("ledger", fmt.Sprintf("z%02d", step), rebuildRecord("u", 1, 333333, now)); err != nil {
			t.Fatal(err)
		}
		if err := s.Put("ledger", "a", rebuildRecord("u", int64(step+1), 333333, now)); err != nil {
			t.Fatal(err)
		}
		p, err := rebuildStep(t, s, now, 2)
		if err == nil {
			assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
			return
		}
		if !errors.Is(err, ErrNotificationRebuildPending) {
			t.Fatal(err)
		}
	}
	t.Fatal("normal writes repeatedly invalidated reconstruction")
}

func TestUsageRebuildCanonicalAndPartialMutationRollBackTogether(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	err := s.CompareAndPutRecords(nil, []RecordWrite{{Kind: "ledger", ID: "a", Value: rebuildRecord("u", 900, 500000, now)}, {Kind: "bad", ID: "fail", Value: make(chan int)}})
	if err == nil {
		t.Fatal("invalid second write committed transaction")
	}
	p := finishRebuild(t, s, now, 1, 3)
	assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
	if p.Users[0].UsedBytes != 2 {
		t.Fatal("rolled-back delta leaked into partial usage", p)
	}
}

func TestUsageRebuildCancellationDoesNotAdvancePartialFrontier(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 2); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	observer := installNotificationReadObserver(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer.afterLedgerRow = func(n int64) {
		if n == 4 {
			cancel()
		}
	}
	p, err := s.NotificationInputPageWithBudget(ctx, "", 100, now, NotificationColdBudget{Rows: 2, Bytes: 4096})
	if !errors.Is(err, context.Canceled) || len(p.Users) != 0 {
		t.Fatalf("cancel exposed partial: %+v %v", p, err)
	}
	observer.afterLedgerRow = nil
	p = finishRebuild(t, s, now, 2, 2)
	assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
}

func TestUsageRebuildBudgetIsSharedAcrossColdAccounts(t *testing.T) {
	s, now := rebuildFixture(t)
	for i := 0; i < 20; i++ {
		if err := s.PutUser(domain.User{ID: fmt.Sprintf("user%02d", i), Name: "User", Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 7; i++ {
		if err := s.Put("ledger", fmt.Sprintf("row%02d", i), rebuildRecord("u", 1, 1000000, now)); err != nil {
			t.Fatal(err)
		}
	}
	observer := installNotificationReadObserver(t, s)
	p, err := rebuildStep(t, s, now, 2)
	if !errors.Is(err, ErrNotificationRebuildPending) || len(p.Users) != 21 {
		t.Fatal(p, err)
	}
	if q, r := observer.Counts(); q != 2 || r != 5 {
		t.Fatalf("not one shared bounded scan: queries=%d rows=%d", q, r)
	}
}

func TestUsageRebuildNewCycleAndResetInvalidatePartialWindow(t *testing.T) {
	s, _ := rebuildFixture(t)
	loc := service.DefaultLocation
	oct := time.Date(2026, 10, 31, 12, 0, 0, 0, loc)
	nov := time.Date(2026, 11, 1, 4, 0, 0, 0, loc)
	cycle := service.CyclePolicy{Mode: "monthly", Day: 1, Anchor: time.Date(2026, 10, 1, 0, 0, 0, 0, loc), Timezone: "UTC+8"}
	if err := s.PutEntitlement(service.Entitlement{UserID: "u", StartsAt: cycle.Anchor, Cycle: cycle}); err != nil {
		t.Fatal(err)
	}
	for i, at := range []time.Time{oct, nov.Add(-3 * time.Hour), nov.Add(-time.Hour), nov.AddDate(0, 1, 0)} {
		if err := s.Put("ledger", string(rune('a'+i)), rebuildRecord("u", int64(i+1), 500000, at)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, oct, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	// New calendar window cannot reuse October's partially accumulated numerator.
	if _, err := rebuildStep(t, s, nov, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	reset := nov.Add(-2 * time.Hour)
	if err := s.ManualReset("u", "synthetic boundary", reset); err != nil {
		t.Fatal(err)
	}
	p := finishRebuild(t, s, nov, 1, 5)
	end := time.Date(2026, 12, 1, 0, 0, 0, 0, loc)
	assertRebuildMatchesCanonical(t, s, p, reset, end)
	if p.Users[0].UsedBytes != 2 || p.Users[0].CycleID != reset.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("wrong reset/future interval: %+v", p)
	}
}

func TestUsageRebuildDirtyRawWriteAndCorruptPartialRestartCanonically(t *testing.T) {
	for _, fault := range []string{"raw-write", "corrupt-partial", "unknown-partial-version"} {
		t.Run(fault, func(t *testing.T) {
			s, now := rebuildFixture(t)
			for _, id := range []string{"a", "b", "c"} {
				if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
				t.Fatal(err)
			}
			switch fault {
			case "raw-write":
				raw, err := s.seal("ledger", "a", rebuildRecord("u", 5, 500000, now))
				if err != nil {
					t.Fatal(err)
				}
				if _, err = s.db.Exec(`UPDATE records SET data=? WHERE kind='ledger' AND id='a'`, raw); err != nil {
					t.Fatal(err)
				}
			case "corrupt-partial":
				if _, err := s.db.Exec(`UPDATE usage_rebuilds SET data=X'00'`); err != nil {
					t.Fatal(err)
				}
			case "unknown-partial-version":
				tx, err := s.beginWriteTx()
				if err != nil {
					t.Fatal(err)
				}
				p, err := s.readUsageRebuildTx(tx, "u")
				if err != nil {
					t.Fatal(err)
				}
				p.Version = 99
				if err = s.writeUsageRebuildTx(tx, "u", p); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(); err != nil {
					t.Fatal(err)
				}
			}
			p := finishRebuild(t, s, now, 1, 4)
			assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
		})
	}
}

func TestUsageRebuildRejectsMalformedRecordAndOversizedIdentityWithoutCompletion(t *testing.T) {
	for _, fault := range []string{"json-type", "oversized-id", "nul-id"} {
		t.Run(fault, func(t *testing.T) {
			s, now := rebuildFixture(t)
			for _, id := range []string{"a", "b", "c"} {
				if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
				t.Fatal(err)
			}
			switch fault {
			case "json-type":
				if err := s.Put("ledger", "b", map[string]string{"rawBytes": "invalid"}); err != nil {
					t.Fatal(err)
				}
			case "oversized-id":
				if err := s.Put("ledger", "b"+strings.Repeat("x", 8192), rebuildRecord("u", 1, 500000, now)); err != nil {
					t.Fatal(err)
				}
			case "nul-id":
				if err := s.Put("ledger", "b\x00extra", rebuildRecord("u", 1, 500000, now)); err != nil {
					t.Fatal(err)
				}
				p := finishRebuild(t, s, now, 1, 5)
				assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
				return
			}
			for step := 0; step < 4; step++ {
				p, err := rebuildStep(t, s, now, 1)
				if err == nil {
					t.Fatalf("malformed fact became complete: %+v", p)
				}
				for _, u := range p.Users {
					if !u.UsageUnknown {
						t.Fatalf("malformed evidence exposed usage: %+v", p)
					}
				}
			}
		})
	}
}

func TestUsageRebuildUsesByteBudgetAndEmptyLedgerID(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"", "b", "c"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	var size int64
	if err := s.db.QueryRow(`SELECT length(data) FROM records WHERE kind='ledger' AND id=''`).Scan(&size); err != nil {
		t.Fatal(err)
	}
	for step := 0; step < 3; step++ {
		p, err := s.NotificationInputPageWithBudget(context.Background(), "", 100, now, NotificationColdBudget{Rows: 100, Bytes: size})
		if step < 2 {
			if !errors.Is(err, ErrNotificationRebuildPending) {
				t.Fatal(err)
			}
		} else {
			if err != nil {
				t.Fatal(err)
			}
			assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
		}
	}
}

func TestUsageRebuildResettingPeerDoesNotStarveStableColdAccount(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.PutUser(domain.User{ID: "resetting", Name: "Resetting peer", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ {
		if err := s.Put("ledger", fmt.Sprintf("r%d", i), rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 2); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	for step := 1; step <= 3; step++ {
		logicalNow := now.Add(time.Duration(step) * time.Second)
		if err := s.ManualReset("resetting", "synthetic repeated reset", logicalNow); err != nil {
			t.Fatal(err)
		}
		p, err := rebuildStep(t, s, logicalNow, 2)
		if !errors.Is(err, ErrNotificationRebuildPending) {
			t.Fatalf("reset peer should remain pending: %+v %v", p, err)
		}
		for _, u := range p.Users {
			if u.UserID == "u" && step == 3 {
				if u.UsageUnknown || u.UsedBytes != 4 {
					t.Fatalf("reset peer starved stable account: %+v", p)
				}
				return
			}
		}
	}
	t.Fatal("stable account missing")
}

func TestUsageRebuildRefusesNonBinaryRecordOrderBeforeMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nocase.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT COLLATE NOCASE NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id))`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if s != nil {
		s.Close()
	}
	if !errors.Is(err, ErrUnsupportedSchema) {
		t.Fatalf("alternate ID order accepted: %v", err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("unsupported store mutated: %d %v", n, err)
	}
}

func TestUsageRebuildReopenDiscardsFalseCleanPartial(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	var path, original string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='usage_ledger_update'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER usage_ledger_update`); err != nil {
		t.Fatal(err)
	}
	raw, err := s.seal("ledger", "a", rebuildRecord("u", 9, 500000, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`UPDATE records SET data=? WHERE kind='ledger' AND id='a'`, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(original); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err = rebuildStep(t, reopened, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	p := finishRebuild(t, reopened, now, 1, 3)
	assertRebuildMatchesCanonical(t, reopened, p, time.Time{}, time.Time{})
	if p.Users[0].UsedBytes != 6 {
		t.Fatal("reopen trusted false-clean partial", p)
	}
}

func TestUsageRebuildBackupRestoreOmitsOnlyDerivedProgress(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"meter-inbox", "meter-receipts", "meter-pending", "accounting-holds"} {
		if err := s.Put(kind, "retained", map[string]string{"evidence": "synthetic retained fact"}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	after, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if !bytes.Equal(a, b) {
		t.Fatal("derived progress changed canonical backup")
	}
	target, err := Open(filepath.Join(t.TempDir(), "restore.db"), bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	limits := BackupLimits{MaxRows: 1000, MaxBytes: 1 << 20, MaxRecordBytes: 1 << 20}
	if err = target.ImportBackup(context.Background(), limits, func(emit func(BackupFrame) error) error { return s.ExportBackup(context.Background(), limits, emit) }); err != nil {
		t.Fatal(err)
	}
	p := finishRebuild(t, target, now, 1, 4)
	assertRebuildMatchesCanonical(t, target, p, time.Time{}, time.Time{})
	for _, kind := range []string{"meter-inbox", "meter-receipts", "meter-pending", "accounting-holds"} {
		rows, err := target.List(kind)
		if err != nil || len(rows) != 1 {
			t.Fatalf("lost %s: %v %v", kind, rows, err)
		}
	}
}

func TestUsageRebuildOldPhysicalReaderRefusesDerivedTable(t *testing.T) {
	probe := os.Getenv("ROUTEWEAVER_LEGACY_STORE_PROBE")
	if probe == "" {
		t.Skip("opt-in actual d17c61b reader probe; executed separately for compatibility evidence")
	}
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	var path string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(probe, path).CombinedOutput()
	if err != nil || string(out) != "LEGACY_UNSUPPORTED_SCHEMA\n" {
		t.Fatalf("old physical reader accepted partial state: %q %v", out, err)
	}
	reopened, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	p := finishRebuild(t, reopened, now, 1, 3)
	assertRebuildMatchesCanonical(t, reopened, p, time.Time{}, time.Time{})
}

func TestUsageRebuildRefusesColumnCollationOverrideDespiteBinaryPK(t *testing.T) {
	path := filepath.Join(t.TempDir(), "override.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT COLLATE NOCASE NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id COLLATE BINARY))`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if s != nil {
		s.Close()
	}
	if !errors.Is(err, ErrUnsupportedSchema) {
		t.Fatalf("column collation override accepted: %v", err)
	}
}

func TestUsageRebuildUserDeletionCleansOnlyDerivedPartial(t *testing.T) {
	s, now := rebuildFixture(t)
	for _, id := range []string{"a", "b"} {
		if err := s.Put("ledger", id, rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := rebuildStep(t, s, now, 1); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	if err := s.Remove("users", "u"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM usage_rebuilds`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deleted-user partial retained: %d %v", count, err)
	}
	rows, err := s.List("ledger")
	if err != nil || len(rows) != 2 {
		t.Fatal("user deletion lost financial history")
	}
}

func TestUsageRebuildDefaultChunkCommitsBeforeWaitingWriter(t *testing.T) {
	s, now := rebuildFixture(t)
	var path string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	other, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	writes := make([]RecordWrite, 0, 2049)
	for i := 0; i < 2049; i++ {
		writes = append(writes, RecordWrite{Kind: "ledger", ID: fmt.Sprintf("r%05d", i), Value: rebuildRecord("u", 1, 500000, now)})
	}
	if err = s.CompareAndPutRecords(nil, writes); err != nil {
		t.Fatal(err)
	}
	observer := installNotificationReadObserver(t, s)
	entered, attempted := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		<-entered
		close(attempted)
		done <- other.Put("ledger", "a", rebuildRecord("u", 3, 500000, now))
	}()
	observer.afterLedgerRow = func(n int64) {
		if n == 1 {
			close(entered)
			<-attempted
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	began := time.Now()
	p, err := s.NotificationInputPage(ctx, "", 100, now)
	if !errors.Is(err, ErrNotificationRebuildPending) || len(p.Users) != 1 || !p.Users[0].UsageUnknown {
		t.Fatalf("default bounded chunk: %+v %v", p, err)
	}
	if q, r := observer.Counts(); q != 2 || r != 2*notificationRebuildChunkRows+1 {
		t.Fatalf("default chunk exceeded global work: %d %d", q, r)
	}
	observer.afterLedgerRow = nil
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bounded reconstruction starved concurrent writer")
	}
	t.Logf("2049-row fixture first 1024-row chunk and concurrent write completed in %s", time.Since(began))
	p = finishRebuild(t, s, now, notificationRebuildChunkRows, 3)
	assertRebuildMatchesCanonical(t, s, p, time.Time{}, time.Time{})
}

func TestUsageRebuildObservedTimeCorrectionsPreserveExactProviderAndWeight(t *testing.T) {
	s, now := rebuildFixture(t)
	cycle := service.CyclePolicy{Mode: "monthly", Day: 1, Anchor: time.Date(2026, 10, 1, 0, 0, 0, 0, service.DefaultLocation), Timezone: "UTC+8"}
	if err := s.PutEntitlement(service.Entitlement{UserID: "u", StartsAt: cycle.Anchor, Cycle: cycle}); err != nil {
		t.Fatal(err)
	}
	w, err := cycle.Window(now)
	if err != nil {
		t.Fatal(err)
	}
	end := *w.NextReset
	makeRecord := func(raw int64, at time.Time) MeterRecord {
		r := rebuildRecord("u", raw, 333333, at)
		r.ProviderBytes = raw * 10
		return r
	}
	records := map[string]MeterRecord{"a": makeRecord(5, now), "b": makeRecord(3, w.Start.Add(-time.Second)), "c": makeRecord(1, now), "d": makeRecord(2, now)}
	for id, r := range records {
		if err = s.Put("ledger", id, r); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = rebuildStep(t, s, now, 2); !errors.Is(err, ErrNotificationRebuildPending) {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "a", makeRecord(5, end)); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "b", makeRecord(3, now)); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "c", makeRecord(1, w.Start.Add(-time.Second))); err != nil {
		t.Fatal(err)
	}
	p := finishRebuild(t, s, now, 2, 2)
	assertRebuildMatchesCanonical(t, s, p, w.Start, end)
	observer := installNotificationReadObserver(t, s)
	tx, err := s.beginWriteTx()
	if err != nil {
		t.Fatal(err)
	}
	totals, err := s.currentUsageTx(tx, "u", w.Start, end)
	tx.Rollback()
	if err != nil || totals != (service.UsageTotals{RawBytes: 5, ProviderBytes: 50, WeightedBytes: 2}) {
		t.Fatalf("derived exact sums: %+v %v", totals, err)
	}
	if q, _ := observer.Counts(); q != 0 {
		t.Fatal("complete projection was not reused")
	}
}

// Opt-in bounded measurement, not a host-capacity or production SLO claim.
func TestUsageRebuildHundredThousandMeasurement(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_HISTORY_MEASUREMENT") != "1" {
		t.Skip("opt-in 100k synthetic fixture")
	}
	s, now := rebuildFixture(t)
	for offset := 0; offset < 100000; offset += 1000 {
		writes := make([]RecordWrite, 0, 1000)
		for i := offset; i < offset+1000; i++ {
			writes = append(writes, RecordWrite{Kind: "ledger", ID: fmt.Sprintf("r%06d", i), Value: rebuildRecord("u", 1, 500000, now)})
		}
		if err := s.CompareAndPutRecords(nil, writes); err != nil {
			t.Fatal(err)
		}
	}
	started := time.Now()
	var slowest time.Duration
	steps := 0
	for ; steps < 110; steps++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		began := time.Now()
		p, err := s.NotificationInputPageWithBudget(ctx, "", 100, now, DefaultNotificationColdBudget())
		cancel()
		slowest = max(slowest, time.Since(began))
		if err == nil {
			if len(p.Users) != 1 || p.Users[0].UsageUnknown || p.Users[0].UsedBytes != 50000 {
				t.Fatalf("bad complete %+v", p)
			}
			steps++
			break
		}
		if !errors.Is(err, ErrNotificationRebuildPending) {
			t.Fatal(err)
		}
	}
	if steps >= 110 {
		t.Fatal("fixture failed to converge")
	}
	t.Logf("100000 rows, %d committed steps, active elapsed %s, slowest input %s; scheduler delay not included", steps, time.Since(started), slowest)
}

func TestUsageRebuildSoftYieldCommitsConsumedPrefixOnly(t *testing.T) {
	s, now := rebuildFixture(t)
	for i := 0; i < 3; i++ {
		if err := s.Put("ledger", fmt.Sprintf("r%d", i), rebuildRecord("u", 1, 500000, now)); err != nil {
			t.Fatal(err)
		}
	}
	// Delay the metadata pass beyond the soft half-deadline, leaving time
	// for the single consumed body and checkpoint to commit. Hard cancellation
	// rollback is covered separately.
	observer := installNotificationReadObserver(t, s)
	observer.afterLedgerRow = func(n int64) {
		if n == 1 {
			time.Sleep(1100 * time.Millisecond)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	p, err := s.NotificationInputPageWithBudget(ctx, "", 100, now, DefaultNotificationColdBudget())
	if !errors.Is(err, ErrNotificationRebuildPending) || !p.Users[0].UsageUnknown {
		t.Fatalf("%+v %v", p, err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	partial, err := s.readUsageRebuildTx(tx, "u")
	tx.Rollback()
	if err != nil || partial == nil || partial.Frontier == nil || *partial.Frontier != "r0" {
		t.Fatalf("partial=%+v err=%v", partial, err)
	}
	observer.afterLedgerRow = nil
	// Mutate already-scanned and unread sides after the yielded transaction.
	if err = s.Put("ledger", "r0", rebuildRecord("u", 3, 500000, now)); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "r2", rebuildRecord("u", 3, 500000, now)); err != nil {
		t.Fatal(err)
	}
	p = finishRebuild(t, s, now, 10, 2)
	if p.Users[0].UsedBytes != 4 {
		t.Fatal(p)
	}
}
