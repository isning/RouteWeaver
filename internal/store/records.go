package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func (s *Store) migrate() error {
	ctx := context.Background()
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return e
	}
	defer conn.Close()
	// No application table needs to exist yet. Acquire the writer before schema
	// reads without touching an unknown database's rows or triggers.
	if _, e = conn.ExecContext(ctx, `BEGIN IMMEDIATE`); e != nil {
		return e
	}
	defer conn.ExecContext(ctx, `ROLLBACK`)
	if e = validateExistingSchema(ctx, conn); e != nil {
		return unsupportedSchema(e)
	}
	_, e = conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS counters(kind TEXT NOT NULL,id TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS identities(username TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS token_index(kind TEXT NOT NULL,digest TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(kind,digest));
 INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
 INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,strftime('%Y-%m-%dT%H:%M:%SZ','now'));`)
	if e != nil {
		return e
	}
	_, e = conn.ExecContext(ctx, `COMMIT`)
	return e
}
func (s *Store) verifyEncryption() error {
	if err := s.checkLegacyNotificationSize(s.db); err != nil {
		return err
	}
	rows, e := s.db.Query(`SELECT kind,id,data FROM records`)
	if e != nil {
		return e
	}
	providerFenceRequired := false
	for rows.Next() {
		var k, id string
		var b []byte
		if e = rows.Scan(&k, &id, &b); e != nil {
			rows.Close()
			return e
		}
		var raw json.RawMessage
		if e = s.open(k, id, b, &raw); e != nil {
			rows.Close()
			return fmt.Errorf("database key mismatch or corrupted record")
		}
		needed, err := providerRecordNeedsFence(k, raw)
		if err != nil {
			rows.Close()
			return err
		}
		providerFenceRequired = providerFenceRequired || needed
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if providerFenceRequired {
		var present int
		if err := s.db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version=?`, providerSuspensionMigrationVersion).Scan(&present); err != nil {
			return err
		}
		if present != 1 {
			return unsupportedSchema(fmt.Errorf("provider admission policy requires its migration fence"))
		}
	}
	return s.put("metadata", "key-check", map[string]int{"version": 1})
}
func (s *Store) Ready(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = validateBackupSchema(ctx, tx); err != nil {
		return unsupportedSchema(err)
	}
	if err = validateMigrationVersions(ctx, tx); err != nil {
		return unsupportedSchema(err)
	}
	return nil
}
func (s *Store) get(kind, id string, out any) error {
	var b []byte
	e := s.db.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&b)
	if e == sql.ErrNoRows {
		return ErrNotFound
	}
	if e != nil {
		return e
	}
	return s.open(kind, id, b, out)
}
func (s *Store) Get(kind, id string, out any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(kind, id, out)
}
func (s *Store) Put(kind, id string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.put(kind, id, value)
}
func (s *Store) Remove(kind, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	n, e := s.deleteTx(tx, kind, id)
	if e != nil {
		return e
	}
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

func (s *Store) List(kind string) ([]json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list(kind)
}
func (s *Store) list(kind string) ([]json.RawMessage, error) {
	out := []json.RawMessage{}
	rows, e := s.db.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, kind)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			return nil, e
		}
		var v json.RawMessage
		if e = s.open(kind, id, b, &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Tenant-scoped kinds ensure a guessed ID cannot select another owner's record.
func TenantKind(owner, kind string) string { return "tenant/" + owner + "/" + kind }
func (s *Store) TenantGet(owner, kind, id string, out any) error {
	return s.Get(TenantKind(owner, kind), id, out)
}
func (s *Store) TenantPut(owner, kind, id string, value any) error {
	if owner == "" || strings.Contains(owner, "/") {
		return fmt.Errorf("owner required")
	}
	return s.Put(TenantKind(owner, kind), id, value)
}
func (s *Store) TenantList(owner, kind string) ([]json.RawMessage, error) {
	return s.List(TenantKind(owner, kind))
}
func (s *Store) TenantRemove(owner, kind, id string) error {
	return s.Remove(TenantKind(owner, kind), id)
}

type AuditEvent struct {
	ID       string    `json:"id"`
	ActorID  string    `json:"actorId"`
	Action   string    `json:"action"`
	TargetID string    `json:"targetId"`
	At       time.Time `json:"at"`
}

func (s *Store) Audit(actor, action, target string) error {
	id := fmt.Sprintf("%d", time.Now().UnixNano())
	return s.Put("audit", id, AuditEvent{id, actor, action, target, time.Now().UTC()})
}

// PutImmutable accepts an identical retry but rejects reuse of a durable event ID.
func (s *Store) PutImmutable(kind, id string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var old json.RawMessage
	if e := s.getTx(tx, kind, id, &old); e == nil {
		now, e := json.Marshal(value)
		if e != nil {
			return e
		}
		if string(old) != string(now) {
			return fmt.Errorf("event identity conflicts with accepted payload")
		}
		return nil
	} else if e != ErrNotFound {
		return e
	}
	if e = s.putTx(tx, kind, id, value); e != nil {
		return e
	}
	return tx.Commit()
}

// GenerateRecord atomically advances a per-record generation and writes the
// corresponding encrypted desired state. The caller never reserves a generation
// separately from the payload that owns it.
func (s *Store) GenerateRecord(kind, id string, build func(uint64) (any, error)) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return 0, e
	}
	defer tx.Rollback()
	var n int64
	e = tx.QueryRow(`SELECT value FROM counters WHERE kind=? AND id=?`, kind, id).Scan(&n)
	if e != nil && e != sql.ErrNoRows {
		return 0, e
	}
	if n == int64(^uint64(0)>>1) {
		return 0, fmt.Errorf("generation exhausted")
	}
	n++
	v, e := build(uint64(n))
	if e != nil {
		return 0, e
	}
	if _, e = tx.Exec(`INSERT INTO counters(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value`, kind, id, n); e != nil {
		return 0, e
	}
	if e = s.putTx(tx, kind, id, v); e != nil {
		return 0, e
	}
	return uint64(n), tx.Commit()
}

type RecordWrite struct {
	Kind  string
	ID    string
	Value any
}

// UpdateRecords changes a related set of records under one SQLite transaction.
// The callback is pure and must not call the store recursively.
func (s *Store) UpdateRecords(kind, id string, change func(json.RawMessage) ([]RecordWrite, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var b []byte
	var old json.RawMessage
	e = tx.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&b)
	if e != nil && e != sql.ErrNoRows {
		return e
	}
	if e == nil {
		if e = s.open(kind, id, b, &old); e != nil {
			return e
		}
	}
	writes, e := change(old)
	if e != nil {
		return e
	}
	for _, v := range writes {
		if e = s.putTx(tx, v.Kind, v.ID, v.Value); e != nil {
			return e
		}
	}
	return tx.Commit()
}
