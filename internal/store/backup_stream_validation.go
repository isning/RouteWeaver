package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// All lookups use primary/unique indexes. No plaintext JSON is passed to SQLite,
// including temporary tables, sort keys, or WAL pages.
func (s *Store) validateBackupDatabase(ctx context.Context, tx *sql.Tx, l BackupLimits) error {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM records)+(SELECT count(*) FROM identities)+(SELECT count(*) FROM token_index)+(SELECT count(*) FROM counters)+(SELECT count(*) FROM schema_migrations)`).Scan(&n); err != nil {
		return err
	}
	if n > l.MaxRows {
		return errors.New("backup exceeds configured row limit")
	}
	// Check sizes in SQLite before asking the driver to allocate a record blob.
	var kind string
	err := tx.QueryRowContext(ctx, `SELECT substr(kind,1,128) FROM records WHERE length(data)>? LIMIT 1`, l.MaxRecordBytes+s.aead.NonceSize()+s.aead.Overhead()).Scan(&kind)
	if err == nil {
		return fmt.Errorf("%w (category %q)", ErrBackupRecordLimit, kind)
	}
	if err != sql.ErrNoRows {
		return err
	}
	for _, q := range []string{
		`SELECT count(*) FROM records WHERE length(kind)>4096 OR length(id)>4096`,
		`SELECT count(*) FROM identities WHERE length(username)>4096 OR length(account_id)>4096`,
		`SELECT count(*) FROM token_index WHERE length(kind)>4096 OR length(digest)>4096 OR length(record_id)>4096`,
		`SELECT count(*) FROM counters WHERE length(kind)>4096 OR length(id)>4096`,
		`SELECT count(*) FROM schema_migrations WHERE length(applied_at)>128`,
	} {
		if err = tx.QueryRowContext(ctx, q).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return errors.New("backup contains oversized index fields")
		}
	}
	var check struct {
		Version int `json:"version"`
	}
	if err = s.backupGet(ctx, tx, "metadata", "key-check", &check); err != nil || check.Version != 1 {
		return errors.New("backup key metadata missing or unsupported")
	}
	migrations := 0
	err = s.walkBackup(ctx, tx, l, func(f BackupFrame) error {
		switch {
		case f.Record != nil:
			r := f.Record
			if r.Kind == "accounts" {
				var a Account
				if err := json.Unmarshal(r.Data, &a); err != nil {
					return err
				}
				var username string
				if err := tx.QueryRowContext(ctx, `SELECT username FROM identities WHERE account_id=?`, r.ID).Scan(&username); err != nil || username != a.Username {
					return errors.New("incomplete backup identity index")
				}
			}
			var lookupError error
			token := func(kind, digest string) string {
				var id string
				e := tx.QueryRowContext(ctx, `SELECT record_id FROM token_index WHERE kind=? AND digest=?`, kind, digest).Scan(&id)
				if e != nil && e != sql.ErrNoRows {
					lookupError = e
				}
				return id
			}
			counter := func(kind, id string) (int64, bool) {
				var n int64
				e := tx.QueryRowContext(ctx, `SELECT value FROM counters WHERE kind=? AND id=?`, kind, id).Scan(&n)
				if e != nil && e != sql.ErrNoRows {
					lookupError = e
				}
				return n, e == nil
			}
			if err := validateBackupRelationship(*r, token, counter); err != nil {
				return err
			}
			return lookupError
		case f.Identity != nil:
			var a Account
			i := f.Identity
			if err := s.backupGet(ctx, tx, "accounts", i.AccountID, &a); err != nil || a.Username != i.Username {
				return errors.New("orphaned backup identity index")
			}
		case f.Token != nil:
			t := f.Token
			if t.Kind == "feeds" {
				owner, id, ok := strings.Cut(t.RecordID, "/")
				if !ok || owner == "" || id == "" || strings.Contains(id, "/") {
					return errors.New("invalid backup feed index")
				}
				var output struct {
					TokenDigest string `json:"tokenDigest"`
				}
				if err := s.backupGet(ctx, tx, TenantKind(owner, "outputs"), id, &output); err != nil || output.TokenDigest != t.Digest {
					return errors.New("orphaned backup feed index")
				}
			}
		case f.Migration != nil:
			migrations++
			if f.Migration.Version != migrations {
				return errors.New("unsupported backup migration history")
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if migrations != BackupSchemaVersion {
		return errors.New("incomplete backup migrations")
	}
	return nil
}
func (s *Store) backupGet(ctx context.Context, tx *sql.Tx, kind, id string, out any) error {
	var b []byte
	if err := tx.QueryRowContext(ctx, `SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&b); err != nil {
		return err
	}
	return s.open(kind, id, b, out)
}
