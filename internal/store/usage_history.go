package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"routeweaver/internal/service"
	"time"
)

// This is only a membership index, not another accounting authority. Every query
// decrypts the selected canonical facts and uses the unchanged exact reducer.
// Counts plus distinct canonical IDs and checked ownership prove completeness;
// the authenticated generation fence also detects mutation/replay of derived
// rows. Exact trigger definitions reject presently replaced/no-op fences. As
// with canonical projections, hostile SQL that disables then restores identical
// triggers before observation can conceal prior writes; this is not external
// anti-rollback state. Reopen NEVER trusts any previously derived state.
type usageHistoryStamp struct {
	Canonical int64 `json:"canonical"`
	Derived   int64 `json:"derived"`
}

func (s *Store) usageHistoryToken(owner string) string {
	mac := hmac.New(sha256.New, s.usageLookupKey)
	mac.Write([]byte("routeweaver/usage-history/owner/v1\x00"))
	mac.Write([]byte(owner))
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *Store) sealUsageHistory(purpose string, value any) ([]byte, error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, s.usageAEAD.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.usageAEAD.Seal(nonce, nonce, plain, []byte("routeweaver/usage-history/v1/"+purpose)), nil
}
func (s *Store) openUsageHistory(purpose string, data []byte, value any) bool {
	n := s.usageAEAD.NonceSize()
	if len(data) < n {
		return false
	}
	plain, err := s.usageAEAD.Open(nil, data[:n], data[n:], []byte("routeweaver/usage-history/v1/"+purpose))
	return err == nil && json.Unmarshal(plain, value) == nil
}

// Exact definitions are shared with installers. A same-name no-op trigger must
// not turn unsigned metadata back into apparently complete history.
var usageHistoryTriggerDefinitions = func() map[string]string {
	definitions := map[string]string{
		"usage_ledger_insert": usageLedgerInsertTrigger,
		"usage_ledger_update": usageLedgerUpdateTrigger,
		"usage_ledger_delete": usageLedgerDeleteTrigger,
	}
	for _, table := range []string{"usage_history", "usage_history_owners"} {
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			name := table + "_" + op
			definitions[name] = `CREATE TRIGGER ` + name + ` AFTER ` + op + ` ON ` + table + ` BEGIN
    SELECT CASE WHEN (SELECT generation FROM usage_history_state WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'history generation exhausted') END;
    UPDATE usage_history_state SET generation=generation+1 WHERE id=1;
   END`
		}
	}
	return definitions
}()

func usageHistoryTriggersValidTx(ctx context.Context, tx *sql.Tx) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name,CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_schema WHERE type='trigger' AND name IN ('usage_ledger_insert','usage_ledger_update','usage_ledger_delete','usage_history_INSERT','usage_history_UPDATE','usage_history_DELETE','usage_history_owners_INSERT','usage_history_owners_UPDATE','usage_history_owners_DELETE')`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var name string
		var definition []byte
		if err = rows.Scan(&name, &definition); err != nil {
			return false, err
		}
		if string(definition) != usageHistoryTriggerDefinitions[name] {
			return false, nil
		}
		count++
	}
	return count == len(usageHistoryTriggerDefinitions), rows.Err()
}

// Runs inside initializeUsageProjection's startup writer reservation. Building
// before publication adds startup work but never puts a complete-history writer
// lock on a live overview/admission request. Memory is O(one canonical record).
func (s *Store) initializeUsageHistoryTx(tx *sql.Tx) error {
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS usage_history(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id));
 CREATE TABLE IF NOT EXISTS usage_history_owners(account TEXT PRIMARY KEY,data BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_history_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,data BLOB NOT NULL);`); err != nil {
		return err
	}
	for _, table := range []string{"usage_history", "usage_history_owners"} {
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			name := table + "_" + op
			if _, err := tx.Exec(`DROP TRIGGER IF EXISTS ` + name); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`DELETE FROM usage_history; DELETE FROM usage_history_owners; DELETE FROM usage_history_state; INSERT INTO usage_history_state VALUES(1,0,X'');`); err != nil {
		return err
	}
	// Populate before installing derived mutation triggers: the final fence is
	// issued only after the whole canonical scan and all owner counts succeed.
	rows, err := tx.Query(`SELECT id,data FROM records WHERE kind='ledger' ORDER BY id`)
	if err != nil {
		return err
	}
	valid := true
	for rows.Next() {
		var id string
		var raw []byte
		var record MeterRecord
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		if err = s.open("ledger", id, raw, &record); err != nil {
			valid = false
			break
		}
		if _, err = tx.Exec(`INSERT INTO usage_history(account,id) VALUES(?,?)`, s.usageHistoryToken(record.UserID), id); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if valid {
		counts, err := tx.Query(`SELECT account,count(*) FROM usage_history GROUP BY account`)
		if err != nil {
			return err
		}
		for counts.Next() {
			var token string
			var count int64
			if err = counts.Scan(&token, &count); err != nil {
				counts.Close()
				return err
			}
			if err = s.writeUsageHistoryCountTx(tx, token, count); err != nil {
				counts.Close()
				return err
			}
		}
		err = counts.Err()
		counts.Close()
		if err != nil {
			return err
		}
	}
	for _, table := range []string{"usage_history", "usage_history_owners"} {
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			name := table + "_" + op
			if _, err := tx.Exec(usageHistoryTriggerDefinitions[name]); err != nil {
				return err
			}
		}
	}
	if !valid {
		return nil
	} // Canonical typed decoding remains authoritative at read.
	return s.writeUsageHistoryStampTx(tx, 0)
}

func (s *Store) usageHistoryValidTx(ctx context.Context, tx *sql.Tx, canonical int64) (bool, error) {
	var generation int64
	var data []byte
	err := tx.QueryRowContext(ctx, `SELECT generation,CASE WHEN length(data)<=4096 THEN data ELSE NULL END FROM usage_history_state WHERE id=1`).Scan(&generation, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var stamp usageHistoryStamp
	if generation < 0 || !s.openUsageHistory("stamp", data, &stamp) || stamp.Canonical != canonical || stamp.Derived != generation {
		return false, nil
	}
	return usageHistoryTriggersValidTx(ctx, tx)
}
func (s *Store) writeUsageHistoryStampTx(tx *sql.Tx, canonical int64) error {
	var generation int64
	if err := tx.QueryRow(`SELECT generation FROM usage_history_state WHERE id=1`).Scan(&generation); err != nil {
		return err
	}
	data, err := s.sealUsageHistory("stamp", usageHistoryStamp{Canonical: canonical, Derived: generation})
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE usage_history_state SET data=? WHERE id=1`, data)
	return err
}
func (s *Store) readUsageHistoryCountTx(ctx context.Context, tx *sql.Tx, token string) (count int64, found, valid bool, err error) {
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT CASE WHEN length(data)<=4096 THEN data ELSE NULL END FROM usage_history_owners WHERE account=?`, token).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, false, nil
	}
	if err != nil {
		return
	}
	found = true
	valid = s.openUsageHistory("count/"+token, raw, &count) && count >= 0
	return
}
func (s *Store) writeUsageHistoryCountTx(tx *sql.Tx, token string, count int64) error {
	data, err := s.sealUsageHistory("count/"+token, count)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO usage_history_owners(account,data) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data`, token, data)
	return err
}

// Called after one canonical mutation, before acknowledging its existing cycle
// projection generation. A dirty history fence is never repaired by ordinary
// writes or cycle projection invalidation; only startup reconstructs it.
func (s *Store) updateUsageHistoryTx(tx *sql.Tx, before int64, id string, old, next *MeterRecord) error {
	valid, err := s.usageHistoryValidTx(context.Background(), tx, before)
	if err != nil {
		return err
	}
	if !valid {
		return nil
	}
	delta := map[string]int64{}
	if old != nil {
		delta[s.usageHistoryToken(old.UserID)]--
	}
	if next != nil {
		delta[s.usageHistoryToken(next.UserID)]++
	}
	for token, d := range delta {
		count, found, valid, err := s.readUsageHistoryCountTx(context.Background(), tx, token)
		if err != nil {
			return err
		}
		// Missing is known-empty only under a valid global index fence and when no
		// prior row belongs to this owner. Missing proof alone never proves empty.
		if !found {
			valid = old == nil || s.usageHistoryToken(old.UserID) != token
		}
		if !valid || d < 0 && count < -d || d > 0 && count > math.MaxInt64-d {
			_, err = tx.Exec(`UPDATE usage_history_state SET data=X'' WHERE id=1`)
			return err
		}
		if err = s.writeUsageHistoryCountTx(tx, token, count+d); err != nil {
			return err
		}
	}
	if old != nil {
		result, err := tx.Exec(`DELETE FROM usage_history WHERE account=? AND id=?`, s.usageHistoryToken(old.UserID), id)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			_, err = tx.Exec(`UPDATE usage_history_state SET data=X'' WHERE id=1`)
			return err
		}
	}
	if next != nil {
		if _, err = tx.Exec(`INSERT INTO usage_history(account,id) VALUES(?,?)`, s.usageHistoryToken(next.UserID), id); err != nil {
			return err
		}
	}
	return s.writeUsageHistoryStampTx(tx, before+1)
}

// A false usable result instructs the caller to run the canonical full scan IN
// THE SAME snapshot. No partial/index-only result ever escapes as complete.
func (s *Store) indexedUsageTx(ctx context.Context, tx *sql.Tx, owner string, start, end time.Time) (totals service.UsageTotals, usable bool, err error) {
	generation, clean, err := s.usageGenerationTx(tx)
	if err != nil || !clean {
		return totals, false, err
	}
	valid, err := s.usageHistoryValidTx(ctx, tx, generation)
	if err != nil || !valid {
		return totals, false, err
	}
	token := s.usageHistoryToken(owner)
	expected, found, valid, err := s.readUsageHistoryCountTx(ctx, tx, token)
	// A verified complete-global stamp proves absence too: startup emitted a
	// count for every indexed owner, and any subsequent removal increments the
	// derived fence. Still scan membership (expected zero), never skip the check.
	if !found && err == nil {
		valid = true
	}
	if err != nil || !valid {
		return totals, false, err
	}
	// LEFT JOIN counts a dangling membership as corruption rather than dropping it.
	rows, err := tx.QueryContext(ctx, `SELECT h.id,r.data FROM usage_history AS h LEFT JOIN records AS r ON r.kind='ledger' AND r.id=h.id WHERE h.account=? ORDER BY h.id`, token)
	if err != nil {
		return totals, false, err
	}
	defer rows.Close()
	var count int64
	totals, err = reduceUsageRecords(func(r *MeterRecord) (bool, error) {
		if !rows.Next() {
			return false, rows.Err()
		}
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return false, err
		}
		if err := s.open("ledger", id, raw, r); err != nil {
			return false, err
		}
		if r.UserID != owner {
			return false, fmt.Errorf("history owner membership mismatch")
		}
		count++
		return true, nil
	}, owner, start, end)
	if err != nil {
		return service.UsageTotals{}, false, err
	}
	if count != expected {
		return service.UsageTotals{}, false, nil
	}
	return totals, true, nil
}
