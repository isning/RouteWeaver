package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const BackupSchemaVersion = 2
const MaxSnapshotBytes = 15 << 20
const MaxSnapshotRows = 100000

// Snapshot is a logical, transactionally consistent export. Data contains secrets
// and must never be sent or persisted without an authenticated encryption layer.
// It deliberately has no filesystem paths, SQL statements, or executable hooks.
type Snapshot struct {
	SchemaVersion int               `json:"schemaVersion"`
	Records       []BackupRecord    `json:"records"`
	Identities    []BackupIdentity  `json:"identities"`
	Tokens        []BackupToken     `json:"tokens"`
	Counters      []BackupCounter   `json:"counters"`
	Migrations    []BackupMigration `json:"migrations"`
}
type BackupRecord struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}
type BackupIdentity struct {
	Username  string `json:"username"`
	AccountID string `json:"accountId"`
}
type BackupToken struct {
	Kind     string `json:"kind"`
	Digest   string `json:"digest"`
	RecordID string `json:"recordId"`
}
type BackupCounter struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Value int64  `json:"value"`
}
type BackupMigration struct {
	Version   int    `json:"version"`
	AppliedAt string `json:"appliedAt"`
}

// ExportSnapshot holds one SQLite read transaction across every table; a
// concurrent writer cannot split a publication/index or a meter/ledger commit.
func (s *Store) ExportSnapshot(ctx context.Context) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Snapshot{SchemaVersion: BackupSchemaVersion, Records: []BackupRecord{}, Identities: []BackupIdentity{}, Tokens: []BackupToken{}, Counters: []BackupCounter{}, Migrations: []BackupMigration{}}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err = validateBackupSchema(ctx, tx); err != nil {
		return out, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT kind,id,data FROM records ORDER BY kind,id`)
	if err != nil {
		return out, err
	}
	total := 0
	for rows.Next() {
		var v BackupRecord
		var data []byte
		if err = rows.Scan(&v.Kind, &v.ID, &data); err == nil {
			err = s.open(v.Kind, v.ID, data, &v.Data)
		}
		if err != nil {
			rows.Close()
			return out, errors.New("cannot decrypt complete backup")
		}
		total += len(v.Data) + len(v.Kind) + len(v.ID)
		if total > MaxSnapshotBytes || len(out.Records) >= MaxSnapshotRows {
			rows.Close()
			return out, errors.New("backup exceeds size limit")
		}
		out.Records = append(out.Records, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT username,account_id FROM identities ORDER BY username`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v BackupIdentity
		if err = rows.Scan(&v.Username, &v.AccountID); err != nil {
			rows.Close()
			return out, err
		}
		out.Identities = append(out.Identities, v)
		if len(out.Identities) > MaxSnapshotRows {
			rows.Close()
			return out, errors.New("backup exceeds row limit")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT kind,digest,record_id FROM token_index ORDER BY kind,digest`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v BackupToken
		if err = rows.Scan(&v.Kind, &v.Digest, &v.RecordID); err != nil {
			rows.Close()
			return out, err
		}
		out.Tokens = append(out.Tokens, v)
		if len(out.Tokens) > MaxSnapshotRows {
			rows.Close()
			return out, errors.New("backup exceeds row limit")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT kind,id,value FROM counters ORDER BY kind,id`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v BackupCounter
		if err = rows.Scan(&v.Kind, &v.ID, &v.Value); err != nil {
			rows.Close()
			return out, err
		}
		out.Counters = append(out.Counters, v)
		if len(out.Counters) > MaxSnapshotRows {
			rows.Close()
			return out, errors.New("backup exceeds row limit")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT version,applied_at FROM schema_migrations ORDER BY version`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v BackupMigration
		if err = rows.Scan(&v.Version, &v.AppliedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Migrations = append(out.Migrations, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if err = ValidateSnapshot(out); err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// ValidateSnapshot checks the complete portable schema and relational indexes.
// Unknown record kinds remain opaque JSON so future domain records cannot be
// silently dropped; introducing a SQL table requires a backup schema migration.
func ValidateSnapshot(v Snapshot) error {
	if v.SchemaVersion != BackupSchemaVersion {
		return errors.New("unsupported backup database schema")
	}
	if len(v.Records)+len(v.Identities)+len(v.Tokens)+len(v.Counters) > MaxSnapshotRows {
		return errors.New("backup exceeds row limit")
	}
	if len(v.Migrations) != BackupSchemaVersion {
		return errors.New("incomplete backup migrations")
	}
	for i, m := range v.Migrations {
		if m.Version != i+1 || !validMigrationTime(m.AppliedAt) {
			return errors.New("unsupported backup migration history")
		}
	}
	valid := func(s string) bool {
		return len(s) > 0 && len(s) <= 4096 && utf8.ValidString(s) && !strings.ContainsRune(s, '\x00')
	}
	key := func(k, id string) string { return k + "\x00" + id }
	records := map[string]json.RawMessage{}
	accounts := map[string]Account{}
	for _, r := range v.Records {
		if !valid(r.Kind) || !valid(r.ID) || !json.Valid(r.Data) {
			return errors.New("invalid backup record")
		}
		k := key(r.Kind, r.ID)
		if _, ok := records[k]; ok {
			return errors.New("duplicate backup record")
		}
		records[k] = r.Data
		if r.Kind == "accounts" {
			var a Account
			if json.Unmarshal(r.Data, &a) != nil || a.ID != r.ID || !usernamePattern.MatchString(a.Username) || len(a.PasswordHash) == 0 || (a.Role != "admin" && a.Role != "user") {
				return errors.New("invalid backup account")
			}
			accounts[r.ID] = a
		}
	}
	var check struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(records[key("metadata", "key-check")], &check) != nil || check.Version != 1 {
		return errors.New("backup key metadata missing or unsupported")
	}
	names, ids := map[string]bool{}, map[string]bool{}
	for _, i := range v.Identities {
		a, ok := accounts[i.AccountID]
		if !ok || a.Username != i.Username || names[i.Username] || ids[i.AccountID] {
			return errors.New("invalid backup identity index")
		}
		names[i.Username] = true
		ids[i.AccountID] = true
	}
	if len(ids) != len(accounts) {
		return errors.New("incomplete backup identity index")
	}
	tokens := map[string]bool{}
	for _, t := range v.Tokens {
		k := key(t.Kind, t.Digest)
		if !valid(t.Kind) || !valid(t.Digest) || !valid(t.RecordID) || tokens[k] {
			return errors.New("invalid backup token index")
		}
		tokens[k] = true
		if t.Kind == "feeds" {
			owner, id, ok := strings.Cut(t.RecordID, "/")
			if !ok || owner == "" || id == "" || strings.Contains(id, "/") {
				return errors.New("invalid backup feed index")
			}
			var output struct {
				TokenDigest string `json:"tokenDigest"`
			}
			if json.Unmarshal(records[key(TenantKind(owner, "outputs"), id)], &output) != nil || output.TokenDigest != t.Digest {
				return errors.New("orphaned backup feed index")
			}
		}
	}
	// A generation fence can legitimately outlive a deleted desired record.
	// Preserve these tombstones so restored publication never reuses a generation.
	counters := map[string]bool{}
	for _, c := range v.Counters {
		k := key(c.Kind, c.ID)
		if !valid(c.Kind) || !valid(c.ID) || c.Value < 0 || counters[k] {
			return errors.New("invalid backup generation counter")
		}
		counters[k] = true
	}
	if err := validateBackupRelationships(v); err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil || len(b) > MaxSnapshotBytes {
		return errors.New("backup exceeds size limit")
	}
	return nil
}

// ImportSnapshot only accepts a fresh store and commits every table together.
// Existing accounts or any business record make the target ineligible.
func (s *Store) ImportSnapshot(ctx context.Context, v Snapshot) error {
	if err := ValidateSnapshot(v); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
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
	for _, r := range v.Records {
		b, e := s.seal(r.Kind, r.ID, r.Data)
		if e != nil {
			return e
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO records(kind,id,data) VALUES(?,?,?)`, r.Kind, r.ID, b); err != nil {
			return err
		}
	}
	for _, i := range v.Identities {
		if _, err = tx.ExecContext(ctx, `INSERT INTO identities(username,account_id) VALUES(?,?)`, i.Username, i.AccountID); err != nil {
			return err
		}
	}
	for _, t := range v.Tokens {
		if _, err = tx.ExecContext(ctx, `INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)`, t.Kind, t.Digest, t.RecordID); err != nil {
			return err
		}
	}
	for _, c := range v.Counters {
		if _, err = tx.ExecContext(ctx, `INSERT INTO counters(kind,id,value) VALUES(?,?,?)`, c.Kind, c.ID, c.Value); err != nil {
			return err
		}
	}
	for _, m := range v.Migrations {
		if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)`, m.Version, m.AppliedAt); err != nil {
			return err
		}
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

// RestoreFresh stages privately beside target, validates a durable reopen, then
// publishes with a no-replace hard link. A failed stage cannot damage the source
// or an existing destination. The caller owns subsequent offline activation.
func RestoreFresh(ctx context.Context, target string, key []byte, v Snapshot) error {
	if err := ValidateSnapshot(v); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(target) || len(key) != 32 {
		return errors.New("absolute restore target and 32-byte master key required")
	}
	if _, err := os.Lstat(target); err == nil {
		return errors.New("restore target already exists")
	} else if !os.IsNotExist(err) {
		return err
	}
	dir, err := os.MkdirTemp(filepath.Dir(target), ".restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "store.db")
	s, err := Open(path, key)
	if err != nil {
		return err
	}
	if err = s.ImportSnapshot(ctx, v); err != nil {
		s.Close()
		return err
	}
	if _, err = s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		s.Close()
		return err
	}
	if err = s.Close(); err != nil {
		return err
	}
	s, err = Open(path, key)
	if err != nil {
		return fmt.Errorf("restored store failed reopen verification: %w", err)
	}
	recovered, err := s.ExportSnapshot(ctx)
	if err != nil {
		s.Close()
		return err
	}
	before := canonicalSnapshot(v)
	after := canonicalSnapshot(recovered)
	if !bytes.Equal(before, after) {
		s.Close()
		return errors.New("restored snapshot verification mismatch")
	}
	if _, err = s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		s.Close()
		return err
	}
	if err = s.Close(); err != nil {
		return err
	}
	return publishFreshBackup(ctx, path, target)
}

func validMigrationTime(s string) bool { _, err := time.Parse(time.RFC3339, s); return err == nil }
func canonicalSnapshot(v Snapshot) []byte {
	v.Records = append([]BackupRecord{}, v.Records...)
	v.Identities = append([]BackupIdentity{}, v.Identities...)
	v.Tokens = append([]BackupToken{}, v.Tokens...)
	v.Counters = append([]BackupCounter{}, v.Counters...)
	sort.Slice(v.Records, func(i, j int) bool {
		a, b := v.Records[i], v.Records[j]
		return a.Kind+"\x00"+a.ID < b.Kind+"\x00"+b.ID
	})
	sort.Slice(v.Identities, func(i, j int) bool { return v.Identities[i].Username < v.Identities[j].Username })
	sort.Slice(v.Tokens, func(i, j int) bool {
		a, b := v.Tokens[i], v.Tokens[j]
		return a.Kind+"\x00"+a.Digest < b.Kind+"\x00"+b.Digest
	})
	sort.Slice(v.Counters, func(i, j int) bool {
		a, b := v.Counters[i], v.Counters[j]
		return a.Kind+"\x00"+a.ID < b.Kind+"\x00"+b.ID
	})
	b, _ := json.Marshal(v)
	return b
}
