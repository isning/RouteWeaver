package store

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"math"
	"testing"
	"time"
)

func TestReviewUsageHistoryCrossStoreReopenAndOwnerMoves(t *testing.T) {
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
	for i := 0; i < 40; i++ {
		writer, reader := s, other
		if i%2 == 0 {
			writer, reader = other, s
		}
		owner := []string{"u", "other", ""}[i%3]
		id := fmt.Sprintf("record-%d", i%7)
		if err := writer.Put("ledger", id, rebuildRecord(owner, int64(i+1), 333333, now.Add(time.Duration(i-20)*time.Hour))); err != nil {
			t.Fatal(err)
		}
		if i%5 == 0 {
			if err := writer.Remove("ledger", id); err != nil {
				t.Fatal(err)
			}
		}
		all, err := reader.List("ledger")
		if err != nil {
			t.Fatal(err)
		}
		for _, who := range []string{"u", "other", "", "absent"} {
			assertHistoryIndexed(t, reader, who)
			for _, win := range [][2]time.Time{{{}, {}}, {now.Add(-time.Hour), now.Add(time.Nanosecond)}} {
				want, err := aggregateUsageRecords(all, who, win[0], win[1])
				if err != nil {
					t.Fatal(err)
				}
				got, err := reader.Usage(who, win[0], win[1])
				if err != nil || got != want {
					t.Fatalf("step%d owner%q got%+v want%+v err%v", i, who, got, want, err)
				}
			}
		}
	}
}

func TestReviewUsageHistoryOverflowFallsBackAndRecovers(t *testing.T) {
	s, now := rebuildFixture(t)
	for id, n := range map[string]int64{"A": math.MaxInt64, "a": 1} {
		if err := s.Put("ledger", id, rebuildRecord("u", n, 1, now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Usage("u", time.Time{}, time.Time{}); err == nil {
		t.Fatal("overflow hidden")
	}
	if err := s.Remove("ledger", "a"); err != nil {
		t.Fatal(err)
	}
	assertHistoryIndexed(t, s, "u")
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != math.MaxInt64 {
		t.Fatal(got, err)
	}
}

func TestReviewUsageHistoryDirtyReadDoesNotRepairFence(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 3, 500000, now)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM usage_history`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := s.Put("ledger", fmt.Sprint(i), rebuildRecord("u", 2, 500000, now)); err != nil {
			t.Fatal(err)
		}
		got, err := s.Usage("u", time.Time{}, time.Time{})
		if err != nil || got.RawBytes != int64(5+2*i) {
			t.Fatal(got, err)
		}
		if err := s.readSnapshot(context.Background(), func(tx *sql.Tx) error {
			_, usable, err := s.indexedUsageTx(context.Background(), tx, "u", time.Time{}, time.Time{})
			if usable {
				return fmt.Errorf("dirty index blessed")
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReviewUsageHistoryUsesBinaryMembershipKeys(t *testing.T) {
	s, _ := rebuildFixture(t)
	rows, err := s.db.Query(`SELECT x.name,x.coll FROM pragma_index_list('usage_history') i JOIN pragma_index_xinfo(i.name) x WHERE i.origin='pk' AND x."key"=1 ORDER BY x.seqno`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := []string{"account", "id"}
	n := 0
	for rows.Next() {
		var name, coll string
		if err := rows.Scan(&name, &coll); err != nil {
			t.Fatal(err)
		}
		if n >= len(want) || name != want[n] || coll != "BINARY" {
			t.Fatalf("unexpected membership ordering %s %s", name, coll)
		}
		n++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatal("missing membership key")
	}
}

func TestReviewUsageHistoryModifiedTriggersCannotHideProofReplay(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	token := s.usageHistoryToken("u")
	var oldCount []byte
	if err := s.db.QueryRow(`SELECT data FROM usage_history_owners WHERE account=?`, token).Scan(&oldCount); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("ledger", "b", rebuildRecord("u", 4, 500000, now)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER usage_history_DELETE; CREATE TRIGGER usage_history_DELETE AFTER DELETE ON usage_history BEGIN SELECT 1; END; DROP TRIGGER usage_history_owners_UPDATE; CREATE TRIGGER usage_history_owners_UPDATE AFTER UPDATE ON usage_history_owners BEGIN SELECT 1; END; DELETE FROM usage_history WHERE id='b'; UPDATE usage_history_owners SET data=? WHERE account=?`, oldCount, token); err != nil {
		t.Fatal(err)
	}
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 11 {
		t.Fatalf("altered trigger definitions concealed canonical usage: %+v err %v; want 11", got, err)
	}
	if err := s.Put("ledger", "c", rebuildRecord("u", 5, 500000, now)); err != nil {
		t.Fatal(err)
	}
	got, err = s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 16 {
		t.Fatalf("normal write blessed dirty index: %+v err %v; want 16", got, err)
	}
}

func TestReviewUsageHistoryModifiedCanonicalTriggerCannotHideLedger(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	raw, err := s.seal("ledger", "b", rebuildRecord("u", 4, 500000, now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`DROP TRIGGER usage_ledger_insert; CREATE TRIGGER usage_ledger_insert AFTER INSERT ON records BEGIN SELECT 1; END; INSERT INTO records(kind,id,data) VALUES('ledger','b',?)`, raw); err != nil {
		t.Fatal(err)
	}
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 11 {
		t.Fatalf("altered canonical trigger concealed usage: %+v err %v; want 11", got, err)
	}
}

func TestReviewUsageHistoryModifiedUpdateCannotHideOwnerReplay(t *testing.T) {
	s, now := rebuildFixture(t)
	if err := s.Put("ledger", "a", rebuildRecord("u", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	var previous []byte
	if err := s.db.QueryRow(`SELECT data FROM records WHERE kind='ledger' AND id='a'`).Scan(&previous); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("ledger", "a", rebuildRecord("other", 7, 500000, now)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER usage_ledger_update; CREATE TRIGGER usage_ledger_update AFTER UPDATE ON records BEGIN SELECT 1; END; UPDATE records SET data=? WHERE kind='ledger' AND id='a'`, previous); err != nil {
		t.Fatal(err)
	}
	got, err := s.Usage("u", time.Time{}, time.Time{})
	if err != nil || got.RawBytes != 7 {
		t.Fatalf("replayed owner hidden by zero-membership index: %+v err%v; want7", got, err)
	}
}
