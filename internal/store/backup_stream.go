package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"
)

// ErrBackupRecordLimit permits adapters to report an actionable capacity error
// without exposing arbitrary database or filesystem failure details.
var ErrBackupRecordLimit = errors.New("stored record exceeds the configured backup record limit; increase the reviewed limit or migrate oversized whole-state records")

// BackupFrame is one portable logical row, never SQL or a filesystem path.
// Exactly one field is present. Export order is records, identities, tokens,
// counters, migrations, with each table ordered by its primary key.
type BackupFrame struct {
	Record    *BackupRecord    `json:"record,omitempty"`
	Identity  *BackupIdentity  `json:"identity,omitempty"`
	Token     *BackupToken     `json:"token,omitempty"`
	Counter   *BackupCounter   `json:"counter,omitempty"`
	Migration *BackupMigration `json:"migration,omitempty"`
}

// BackupLimits bounds row allocation and work independently of total history.
// Callers also bound serialized bytes and operation duration.
type BackupLimits struct {
	MaxBytes       int64
	MaxRows        int
	MaxRecordBytes int
}

func (l BackupLimits) valid() bool {
	return l.MaxBytes > 0 && l.MaxBytes <= 1<<30 && l.MaxRows > 0 && l.MaxRows <= 2000000 && l.MaxRecordBytes > 0 && l.MaxRecordBytes <= 128<<20
}
func backupText(s string) bool {
	return len(s) > 0 && len(s) <= 4096 && utf8.ValidString(s) && !strings.ContainsRune(s, '\x00')
}
func (f BackupFrame) order() (int, string, error) {
	n, table, key := 0, 0, ""
	if f.Record != nil {
		n++
		table = 1
		key = f.Record.Kind + "\x00" + f.Record.ID
	}
	if f.Identity != nil {
		n++
		table = 2
		key = f.Identity.Username
	}
	if f.Token != nil {
		n++
		table = 3
		key = f.Token.Kind + "\x00" + f.Token.Digest
	}
	if f.Counter != nil {
		n++
		table = 4
		key = f.Counter.Kind + "\x00" + f.Counter.ID
	}
	if f.Migration != nil {
		n++
		table = 5
		key = fmt.Sprintf("%08d", f.Migration.Version)
	}
	if n != 1 {
		return 0, "", errors.New("backup frame must contain exactly one row")
	}
	return table, key, nil
}
func validateBackupFrame(f BackupFrame, l BackupLimits) error {
	if _, _, err := f.order(); err != nil {
		return err
	}
	switch {
	case f.Record != nil:
		r := f.Record
		if !backupText(r.Kind) || !backupText(r.ID) || !json.Valid(r.Data) {
			return errors.New("invalid backup record")
		}
		if len(r.Data) > l.MaxRecordBytes {
			return ErrBackupRecordLimit
		}
		if r.Kind == "accounts" {
			var a Account
			if json.Unmarshal(r.Data, &a) != nil || a.ID != r.ID || !usernamePattern.MatchString(a.Username) || len(a.PasswordHash) == 0 || (a.Role != "admin" && a.Role != "user") {
				return errors.New("invalid backup account")
			}
		}
	case f.Identity != nil:
		if !backupText(f.Identity.Username) || !backupText(f.Identity.AccountID) {
			return errors.New("invalid backup identity")
		}
	case f.Token != nil:
		t := f.Token
		if !backupText(t.Kind) || !backupText(t.Digest) || !backupText(t.RecordID) {
			return errors.New("invalid backup token")
		}
	case f.Counter != nil:
		c := f.Counter
		if !backupText(c.Kind) || !backupText(c.ID) || c.Value < 0 {
			return errors.New("invalid backup counter")
		}
	case f.Migration != nil:
		m := f.Migration
		if m.Version < 1 || m.Version > BackupSchemaVersion || !validMigrationTime(m.AppliedAt) {
			return errors.New("unsupported backup migration")
		}
	}
	return nil
}

// ExportBackup walks a single read transaction with O(maximum record) memory.
// Validation uses indexed SQL lookups, not a history-sized map. Callback data is
// valid only during the callback and must not be retained without encryption.
func (s *Store) ExportBackup(ctx context.Context, l BackupLimits, emit func(BackupFrame) error) error {
	if !l.valid() {
		return errors.New("invalid backup limits")
	}
	// A long snapshot must not hold the Store mutex or its sole writable
	// connection: admission lease renewal and normal writes remain available.
	// The existing connection is borrowed only to resolve its SQLite filename.
	var path string
	if err := s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		return err
	}
	if path == "" {
		return errors.New("streaming backup requires a file-backed store")
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer reader.Close()
	reader.SetMaxOpenConns(1)
	// Apply connection-local pragmas explicitly; do not change the writer pool.
	if _, err = reader.ExecContext(ctx, `PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY`); err != nil {
		return err
	}
	tx, err := reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = validateBackupSchema(ctx, tx); err != nil {
		return err
	}
	if err = s.validateBackupDatabase(ctx, tx, l); err != nil {
		return err
	}
	if err = s.walkBackup(ctx, tx, l, emit); err != nil {
		return err
	}
	return tx.Commit()
}

// ImportBackup commits only after the producer has authenticated its entire
// input, then checks both directions of known indexes and generation fences.
// The caller must use a private encrypted staging Store until this returns.
func (s *Store) ImportBackup(ctx context.Context, l BackupLimits, produce func(func(BackupFrame) error) error) error {
	if !l.valid() {
		return errors.New("invalid backup limits")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Limit SQLite cache and database growth as well as archive bytes. WAL can
	// temporarily approach another database-sized file during the atomic import.
	var pageSize int64
	if err := s.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=%d", (2*l.MaxBytes+(16<<20))/pageSize)); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var occupied int
	if err = tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM records WHERE NOT (kind='metadata' AND id='key-check'))+(SELECT count(*) FROM identities)+(SELECT count(*) FROM token_index)+(SELECT count(*) FROM counters)`).Scan(&occupied); err != nil {
		return err
	}
	if occupied != 0 {
		return errors.New("restore target is not fresh; existing data is never overwritten")
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM records; DELETE FROM schema_migrations`); err != nil {
		return err
	}
	// Reuse transaction-bound inserts while keeping each frame independently validated.
	recordInsert, err := tx.PrepareContext(ctx, `INSERT INTO records(kind,id,data) VALUES(?,?,?)`)
	if err != nil {
		return err
	}
	defer recordInsert.Close()
	identityInsert, err := tx.PrepareContext(ctx, `INSERT INTO identities(username,account_id) VALUES(?,?)`)
	if err != nil {
		return err
	}
	defer identityInsert.Close()
	tokenInsert, err := tx.PrepareContext(ctx, `INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)`)
	if err != nil {
		return err
	}
	defer tokenInsert.Close()
	counterInsert, err := tx.PrepareContext(ctx, `INSERT INTO counters(kind,id,value) VALUES(?,?,?)`)
	if err != nil {
		return err
	}
	defer counterInsert.Close()
	migrationInsert, err := tx.PrepareContext(ctx, `INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)`)
	if err != nil {
		return err
	}
	defer migrationInsert.Close()
	count, lastTable, lastKey := 0, 0, ""
	err = produce(func(f BackupFrame) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		count++
		if count > l.MaxRows {
			return errors.New("backup exceeds configured row limit")
		}
		if err := validateBackupFrame(f, l); err != nil {
			return err
		}
		table, key, _ := f.order()
		if table < lastTable || (table == lastTable && key <= lastKey) {
			return errors.New("duplicate or unordered backup row")
		}
		lastTable, lastKey = table, key
		var err error
		switch {
		case f.Record != nil:
			r := f.Record
			var b []byte
			b, err = s.seal(r.Kind, r.ID, r.Data)
			if err == nil {
				_, err = recordInsert.ExecContext(ctx, r.Kind, r.ID, b)
			}
		case f.Identity != nil:
			i := f.Identity
			_, err = identityInsert.ExecContext(ctx, i.Username, i.AccountID)
		case f.Token != nil:
			t := f.Token
			_, err = tokenInsert.ExecContext(ctx, t.Kind, t.Digest, t.RecordID)
		case f.Counter != nil:
			c := f.Counter
			_, err = counterInsert.ExecContext(ctx, c.Kind, c.ID, c.Value)
		case f.Migration != nil:
			m := f.Migration
			_, err = migrationInsert.ExecContext(ctx, m.Version, m.AppliedAt)
		}
		return err
	})
	if err != nil {
		return err
	}
	// Surface close failures before validation or commit; deferred closes also cover early returns.
	for _, stmt := range []*sql.Stmt{recordInsert, identityInsert, tokenInsert, counterInsert, migrationInsert} {
		if err = stmt.Close(); err != nil {
			return err
		}
	}
	if err = s.validateBackupDatabase(ctx, tx, l); err != nil {
		return err
	}
	for _, d := range []admissionLiveDomain{leaseLive, budgetLive} {
		if err = s.invalidateAdmissionLiveTx(tx, d); err != nil {
			return err
		}
	}
	if err = s.invalidateUsageTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) walkBackup(ctx context.Context, tx *sql.Tx, l BackupLimits, emit func(BackupFrame) error) error {
	queries := []string{`SELECT kind,id,data FROM records ORDER BY kind,id`, `SELECT username,account_id FROM identities ORDER BY username`, `SELECT kind,digest,record_id FROM token_index ORDER BY kind,digest`, `SELECT kind,id,value FROM counters ORDER BY kind,id`, `SELECT version,applied_at FROM schema_migrations ORDER BY version`}
	count := 0
	for table, q := range queries {
		lastKey, seen := "", false
		rows, err := tx.QueryContext(ctx, q)
		if err != nil {
			return err
		}
		for rows.Next() {
			if err = ctx.Err(); err != nil {
				rows.Close()
				return err
			}
			count++
			if count > l.MaxRows {
				rows.Close()
				return errors.New("backup exceeds configured row limit")
			}
			f := BackupFrame{}
			switch table {
			case 0:
				r := &BackupRecord{}
				var b []byte
				err = rows.Scan(&r.Kind, &r.ID, &b)
				if err == nil {
					err = s.open(r.Kind, r.ID, b, &r.Data)
				}
				f.Record = r
			case 1:
				i := &BackupIdentity{}
				err = rows.Scan(&i.Username, &i.AccountID)
				f.Identity = i
			case 2:
				t := &BackupToken{}
				err = rows.Scan(&t.Kind, &t.Digest, &t.RecordID)
				f.Token = t
			case 3:
				c := &BackupCounter{}
				err = rows.Scan(&c.Kind, &c.ID, &c.Value)
				f.Counter = c
			case 4:
				m := &BackupMigration{}
				err = rows.Scan(&m.Version, &m.AppliedAt)
				f.Migration = m
			}
			if err == nil {
				err = validateBackupFrame(f, l)
			}
			if err == nil {
				_, key, orderErr := f.order()
				if orderErr != nil {
					err = orderErr
				} else if seen && key <= lastKey {
					err = errors.New("unsupported backup primary-key ordering or duplicate row")
				}
				lastKey, seen = key, true
			}
			if err == nil {
				err = emit(f)
			}
			if f.Record != nil {
				clear(f.Record.Data)
			}
			if err != nil {
				rows.Close()
				return err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
