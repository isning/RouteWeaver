package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func TestUsageHistoryOwnerIndexKeepsExactWindowsAndMutations(t *testing.T) {
	s, now := rebuildFixture(t)
	for i := 0; i < 12; i++ {
		owner := "u"
		if i%3 == 0 {
			owner = "other"
		}
		if err := s.Put("ledger", fmt.Sprint(i), rebuildRecord(owner, int64(i+1), 333333, now.Add(time.Duration(i-6)*time.Hour))); err != nil {
			t.Fatal(err)
		}
	}
	check := func() {
		assertHistoryIndexed(t, s, "u")
		assertHistoryIndexed(t, s, "other")
		assertHistoryIndexed(t, s, "absent")
		t.Helper()
		raw, err := s.List("ledger")
		if err != nil {
			t.Fatal(err)
		}
		for _, owner := range []string{"u", "other", "absent"} {
			for _, window := range [][2]time.Time{{{}, {}}, {now.Add(-2 * time.Hour), now.Add(time.Nanosecond)}, {now, now.Add(2 * time.Hour)}, {now.Add(10 * time.Hour), {}}} {
				want, err := aggregateUsageRecords(raw, owner, window[0], window[1])
				if err != nil {
					t.Fatal(err)
				}
				got, err := s.UsageContext(context.Background(), owner, window[0], window[1])
				if err != nil || got != want {
					t.Fatalf("%s %v got%+v want%+v err%v", owner, window, got, want, err)
				}
			}
		}
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM usage_history`).Scan(&n); err != nil || n != len(raw) {
			t.Fatalf("incomplete owner index %d vs%d: %v", n, len(raw), err)
		}
	}
	check()
	if err := s.CompareAndPutRecords(nil, []RecordWrite{{Kind: "ledger", ID: "2", Value: rebuildRecord("other", 9, 500000, now.Add(-time.Hour))}, {Kind: "ledger", ID: "new", Value: rebuildRecord("u", 7, 500000, now.Add(time.Hour))}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("ledger", "1"); err != nil {
		t.Fatal(err)
	}
	check()
}

func TestUsageHistoryTamperingNeverUndercounts(t *testing.T) {
	for _, damage := range []string{
		`DELETE FROM usage_history`,
		`DELETE FROM usage_history_owners`,
		`UPDATE usage_history_owners SET data=X'00'`,
		`UPDATE usage_history_state SET data=X'00'`,
		`DELETE FROM usage_history_state`,
	} {
		t.Run(damage, func(t *testing.T) {
			s, now := rebuildFixture(t)
			if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec(damage); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("ledger", "b", rebuildRecord("u", 4, 500000, now)); err != nil {
				t.Fatal(err)
			}
			got, err := s.Usage("u", time.Time{}, time.Time{})
			if err != nil || got.RawBytes != 11 || got.WeightedBytes != 6 {
				t.Fatalf("undercount %+v %v", got, err)
			}
		})
	}
}

func TestUsageHistoryRawCanonicalWriteStaysInvalidAfterProjectionRecovery(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	raw, err := s.seal("ledger", "b", rebuildRecord("u", 4, 500000, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','b',?)`, raw); err != nil {
		t.Fatal(err)
	}
	tx, err := s.beginWriteTx()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.invalidateUsageTx(tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("ledger", "c", rebuildRecord("u", 5, 500000, now)); err != nil {
		t.Fatal(err)
	}
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 16 {
		t.Fatalf("undercount %+v %v", got, err)
	}
}

func assertHistoryIndexed(t *testing.T, s *Store, owner string) {
	t.Helper()
	err := s.readSnapshot(context.Background(), func(tx *sql.Tx) error {
		_, usable, err := s.indexedUsageTx(context.Background(), tx, owner, time.Time{}, time.Time{})
		if err != nil {
			return err
		}
		if !usable {
			return fmt.Errorf("history index unexpectedly unavailable for %s", owner)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUsageHistoryReopenDiscardsFalseCleanMembership(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	var path, original string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='usage_ledger_insert'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER usage_ledger_insert`); err != nil {
		t.Fatal(err)
	}
	raw, err := s.seal("ledger", "b", rebuildRecord("u", 4, 500000, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','b',?)`, raw); err != nil {
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
	assertHistoryIndexed(t, reopened, "u")
	got, err := reopened.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 11 {
		t.Fatal(got, err)
	}
}

func TestUsageHistoryMalformedForeignOwnerAndRollback(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	err := s.CompareAndPutRecords(nil, []RecordWrite{{Kind: "ledger", ID: "b", Value: rebuildRecord("u", 500, 500000, now)}, {Kind: "bad", ID: "bad", Value: make(chan int)}})
	if err == nil {
		t.Fatal("expected rollback")
	}
	assertHistoryIndexed(t, s, "u")
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 7 {
		t.Fatal(got, err)
	}
	if err = s.Put("ledger", "foreign", json.RawMessage(`{"userId":"other","rawBytes":"bad"}`)); err != nil {
		t.Fatal(err)
	}
	got, err = s.Usage("u", time.Time{}, time.Time{})
	if err == nil || got != (service.UsageTotals{}) {
		t.Fatal("malformed foreign record hidden", got, err)
	}
	var path string
	if err = s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
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
	got, err = reopened.Usage("u", time.Time{}, time.Time{})
	if err == nil || got != (service.UsageTotals{}) {
		t.Fatal("reopen hid malformed foreign record", got, err)
	}
}

func TestUsageHistoryProofReplayAndMissingTriggersFallBack(t *testing.T) {
	for _, damage := range []string{"count-replay", "missing-trigger", "same-cardinality-wrong-owner", "missing-index-table"} {
		t.Run(damage, func(t *testing.T) {
			s, now := rebuildFixture(t)
			if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
				t.Fatal(err)
			}
			token := s.usageHistoryToken("u")
			var original []byte
			if err := s.db.QueryRow(`SELECT data FROM usage_history_owners WHERE account=?`, token).Scan(&original); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("ledger", "b", rebuildRecord("u", 4, 500000, now)); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("ledger", "c", rebuildRecord("other", 99, 500000, now)); err != nil {
				t.Fatal(err)
			}
			var err error
			switch damage {
			case "count-replay":
				_, err = s.db.Exec(`DELETE FROM usage_history WHERE id='b'; UPDATE usage_history_owners SET data=? WHERE account=?`, original, token)
			case "missing-trigger":
				_, err = s.db.Exec(`DROP TRIGGER usage_history_DELETE; DELETE FROM usage_history WHERE id='b'`)
			case "same-cardinality-wrong-owner":
				_, err = s.db.Exec(`UPDATE usage_history SET id='c' WHERE id='b'`)
			case "missing-index-table":
				_, err = s.db.Exec(`DROP TABLE usage_history`)
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.Usage("u", time.Time{}, time.Time{})
			if err != nil || got.RawBytes != 11 {
				t.Fatal(got, err)
			}
		})
	}
}

func TestUsageHistoryLogicalBackupExcludesDerivedAndRebuildsAfterRestore(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	before, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`DELETE FROM usage_history; DELETE FROM usage_history_owners; DELETE FROM usage_history_state`); err != nil {
		t.Fatal(err)
	}
	after, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if !bytes.Equal(a, b) {
		t.Fatal("derived index leaked into logical backup")
	}
	target := projectionTestStore(t)
	limits := BackupLimits{MaxRows: 1000, MaxBytes: 1 << 20, MaxRecordBytes: 1 << 20}
	if err = target.ImportBackup(context.Background(), limits, func(emit func(BackupFrame) error) error { return s.ExportBackup(context.Background(), limits, emit) }); err != nil {
		t.Fatal(err)
	}
	got, err := target.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 7 {
		t.Fatal(got, err)
	}
	var path string
	if err = target.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err = target.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	assertHistoryIndexed(t, reopened, "u")
	got, err = reopened.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 7 {
		t.Fatal(got, err)
	}
}

func TestUsageHistoryMissingCanonicalMarkerCannotResetToFalseEmpty(t *testing.T) {
	s, now := rebuildFixture(t)
	raw, err := s.seal("ledger", "hidden", rebuildRecord("u", 7, 500000, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','hidden',?); DELETE FROM usage_projection_state`, raw); err != nil {
		t.Fatal(err)
	}
	// A recovered generation of zero must not match the originally empty index.
	tx, err := s.beginWriteTx()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.invalidateUsageTx(tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 7 {
		t.Fatal(got, err)
	}
}

func TestUsageHistoryReadSnapshotDoesNotReserveWriterAndRemainsAtomic(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wrote := make(chan error, 1)
	err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		before, usable, err := s.indexedUsageTx(ctx, tx, "u", time.Time{}, time.Time{})
		if err != nil {
			return err
		}
		if !usable || before.RawBytes != 7 {
			return fmt.Errorf("initial snapshot %+v usable %v", before, usable)
		}
		go func() { wrote <- s.Put("ledger", "b", rebuildRecord("u", 4, 500000, now)) }()
		select {
		case err := <-wrote:
			if err != nil {
				return err
			}
		case <-ctx.Done():
			return fmt.Errorf("writer blocked by read snapshot: %w", ctx.Err())
		}
		after, usable, err := s.indexedUsageTx(ctx, tx, "u", time.Time{}, time.Time{})
		if err != nil {
			return err
		}
		if !usable || after != before {
			return fmt.Errorf("torn read snapshot before%+v after%+v usable%v", before, after, usable)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertHistoryIndexed(t, s, "u")
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 11 {
		t.Fatal(got, err)
	}
}
