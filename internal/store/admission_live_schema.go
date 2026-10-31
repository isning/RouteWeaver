package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
)

// These are two independent private invalidation domains, not a membership index.
type admissionLiveDomain string

const leaseLive admissionLiveDomain = "lease"
const budgetLive admissionLiveDomain = "budget"

func (d admissionLiveDomain) kind() string {
	if d == leaseLive {
		return "entry-admission-leases"
	}
	return "admission-budgets"
}
func (d admissionLiveDomain) stateTable() string { return "admission_" + string(d) + "_state" }
func (d admissionLiveDomain) rowsTable() string  { return "admission_" + string(d) + "_windows" }
func liveDomainForKind(kind string) admissionLiveDomain {
	switch kind {
	case "entry-admission-leases":
		return leaseLive
	case "admission-budgets":
		return budgetLive
	}
	return ""
}

func (s *Store) initializeAdmissionCrypto(key []byte) error {
	s.liveAEAD = make(map[admissionLiveDomain]cipher.AEAD)
	s.liveLookupKey = make(map[admissionLiveDomain][]byte)
	for _, d := range []admissionLiveDomain{leaseLive, budgetLive} {
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte("routeweaver/admission-" + string(d) + "/aead/v1"))
		block, err := aes.NewCipher(mac.Sum(nil))
		if err != nil {
			return err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return err
		}
		s.liveAEAD[d] = aead
		mac.Reset()
		mac.Write([]byte("routeweaver/admission-" + string(d) + "/lookup/v1"))
		s.liveLookupKey[d] = mac.Sum(nil)
	}
	return nil
}
func (s *Store) initializeAdmissionLiveState() error {
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, d := range []admissionLiveDomain{leaseLive, budgetLive} {
		state, rows := d.stateTable(), d.rowsTable()
		if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS ` + state + `(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,generation INTEGER NOT NULL,acknowledged INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS ` + rows + `(account TEXT PRIMARY KEY,data BLOB NOT NULL);`); err != nil {
			return err
		}
		for _, op := range []string{"insert", "update", "delete"} {
			condition := "NEW.kind='" + d.kind() + "'"
			if op == "delete" {
				condition = "OLD.kind='" + d.kind() + "'"
			}
			if op == "update" {
				condition += " OR OLD.kind='" + d.kind() + "'"
			}
			name := "admission_" + string(d) + "_" + op
			if _, err = tx.Exec(`DROP TRIGGER IF EXISTS ` + name + `; CREATE TRIGGER ` + name + ` AFTER ` + op + ` ON records WHEN ` + condition + ` BEGIN
 INSERT INTO ` + state + ` SELECT 1,1,0,-1 WHERE NOT EXISTS(SELECT 1 FROM ` + state + ` WHERE id=1);
 SELECT CASE WHEN (SELECT generation FROM ` + state + ` WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'admission generation exhausted') END;
 UPDATE ` + state + ` SET generation=generation+1 WHERE id=1; END;`); err != nil {
				return err
			}
		}
		if err = s.invalidateAdmissionLiveTx(tx, d); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) admissionLiveGenerationTx(tx *sql.Tx, d admissionLiveDomain) (int64, bool, error) {
	var version, current, ack sql.NullInt64
	var triggers int
	prefix := "admission_" + string(d) + "_"
	err := tx.QueryRow(`SELECT (SELECT version FROM `+d.stateTable()+` WHERE id=1),(SELECT generation FROM `+d.stateTable()+` WHERE id=1),(SELECT acknowledged FROM `+d.stateTable()+` WHERE id=1),(SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN (?,?,?))`, prefix+"insert", prefix+"update", prefix+"delete").Scan(&version, &current, &ack, &triggers)
	if err != nil {
		return 0, false, err
	}
	if triggers != 3 {
		return 0, false, errors.New("admission projection triggers missing; reopen store to rebuild derived state")
	}
	return current.Int64, version.Valid && current.Valid && ack.Valid && version.Int64 == 1 && current.Int64 >= 0 && current.Int64 == ack.Int64, nil
}
func (s *Store) invalidateAdmissionLiveTx(tx *sql.Tx, d admissionLiveDomain) error {
	if _, err := tx.Exec(`DELETE FROM ` + d.rowsTable()); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO ` + d.stateTable() + `(id,version,generation,acknowledged) VALUES(1,1,0,0) ON CONFLICT(id) DO UPDATE SET version=1,acknowledged=generation`)
	if err != nil {
		return err
	}
	return s.writeAdmissionLiveRowTx(tx, d, "", true, &admissionLiveWindow{Version: 1})
}
func (s *Store) acknowledgeAdmissionLiveTx(tx *sql.Tx, d admissionLiveDomain, before int64) error {
	r, err := tx.Exec(`UPDATE `+d.stateTable()+` SET acknowledged=generation WHERE id=1 AND version=1 AND generation=? AND acknowledged=?`, before+1, before)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("admission generation changed unexpectedly")
	}
	return nil
}
