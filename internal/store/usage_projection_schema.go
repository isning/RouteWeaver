package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"errors"
)

const usageProjectionVersion = 1

// newStore initializes both cryptographic purposes on every construction path.
// Canonical encryption remains byte-compatible. No derived key is persisted.
func newStore(db *sql.DB, key []byte) (*Store, error) {
	if len(key) != 32 {
		return nil, errors.New("master key must contain 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	canonical, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("routeweaver/usage-window/aead/v1"))
	block, err = aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	derived, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	mac.Reset()
	mac.Write([]byte("routeweaver/usage-window/account-lookup/v1"))
	s := &Store{db: db, aead: canonical, usageAEAD: derived, usageLookupKey: mac.Sum(nil)}
	mac.Reset()
	mac.Write([]byte("routeweaver/private-record-review/v1"))
	s.reviewKey = mac.Sum(nil)
	if err := s.initializeAdmissionCrypto(key); err != nil {
		return nil, err
	}
	return s, nil
}

// initializeUsageProjection is an upgrade/reopen recovery boundary. Only derived
// data is discarded; canonical migration rows and archive digests stay unchanged.
// Reinstalling triggers and invalidating windows happens in one writer transaction.
func (s *Store) initializeUsageProjection() error {
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
 CREATE TABLE IF NOT EXISTS usage_projection_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,generation INTEGER NOT NULL,acknowledged INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS usage_windows(account TEXT PRIMARY KEY,data BLOB NOT NULL);
 DELETE FROM usage_windows;
 INSERT INTO usage_projection_state(id,version,generation,acknowledged) VALUES(1,1,0,0) ON CONFLICT(id) DO UPDATE SET version=1,generation=0,acknowledged=0;
 DROP TRIGGER IF EXISTS usage_ledger_insert;
 DROP TRIGGER IF EXISTS usage_ledger_update;
 DROP TRIGGER IF EXISTS usage_ledger_delete;
 CREATE TRIGGER usage_ledger_insert AFTER INSERT ON records WHEN NEW.kind='ledger' BEGIN
  INSERT INTO usage_projection_state SELECT 1,1,0,-1 WHERE NOT EXISTS(SELECT 1 FROM usage_projection_state WHERE id=1);
  SELECT CASE WHEN (SELECT generation FROM usage_projection_state WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'usage generation exhausted') END;
  UPDATE usage_projection_state SET generation=generation+1 WHERE id=1;
 END;
 CREATE TRIGGER usage_ledger_update AFTER UPDATE ON records WHEN OLD.kind='ledger' OR NEW.kind='ledger' BEGIN
  INSERT INTO usage_projection_state SELECT 1,1,0,-1 WHERE NOT EXISTS(SELECT 1 FROM usage_projection_state WHERE id=1);
  SELECT CASE WHEN (SELECT generation FROM usage_projection_state WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'usage generation exhausted') END;
  UPDATE usage_projection_state SET generation=generation+1 WHERE id=1;
 END;
 CREATE TRIGGER usage_ledger_delete AFTER DELETE ON records WHEN OLD.kind='ledger' BEGIN
  INSERT INTO usage_projection_state SELECT 1,1,0,-1 WHERE NOT EXISTS(SELECT 1 FROM usage_projection_state WHERE id=1);
  SELECT CASE WHEN (SELECT generation FROM usage_projection_state WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'usage generation exhausted') END;
  UPDATE usage_projection_state SET generation=generation+1 WHERE id=1;
 END;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// invalidateUsageTx must discard ALL account windows before acknowledging any
// missed write. Rebuilding just the requesting account would hide stale peers.
func (s *Store) invalidateUsageTx(tx *sql.Tx) error {
	if _, err := tx.Exec(`DELETE FROM usage_windows`); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO usage_projection_state(id,version,generation,acknowledged) VALUES(1,1,0,0) ON CONFLICT(id) DO UPDATE SET version=1,acknowledged=generation`)
	return err
}
