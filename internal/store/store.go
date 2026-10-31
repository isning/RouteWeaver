// Package store owns encrypted SQLite persistence. The master key is supplied by
// the operator, never written to the database. Losing it loses access to records.
package store

import (
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"routeweaver/internal/domain"
	"sync"
	"time"
)

var ErrNotFound = errors.New("not found")

type State struct {
	Nodes     []domain.Node     `json:"nodes"`
	Users     []domain.User     `json:"users"`
	Routes    []domain.Route    `json:"routes"`
	Revisions []domain.Revision `json:"revisions"`
}
type Store struct {
	db             *sql.DB
	aead           cipher.AEAD
	usageAEAD      cipher.AEAD
	usageLookupKey []byte
	reviewKey      []byte
	liveAEAD       map[admissionLiveDomain]cipher.AEAD
	liveLookupKey  map[admissionLiveDomain][]byte
	mu             sync.Mutex
}

func Open(path string, key []byte) (*Store, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("master key must contain 32 bytes")
	}
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	f.Close()
	if e = os.Chmod(path, 0600); e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s, e := newStore(db, key)
	if e != nil {
		db.Close()
		return nil, e
	}
	if _, e = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id));`); e != nil {
		db.Close()
		return nil, e
	}
	if e = s.migrate(); e != nil {
		db.Close()
		return nil, e
	}
	if _, e = s.State(); e != nil {
		db.Close()
		return nil, fmt.Errorf("cannot decrypt existing database: %w", e)
	}
	if e = s.verifyEncryption(); e != nil {
		db.Close()
		return nil, e
	}
	if e = s.initializeUsageProjection(); e != nil {
		db.Close()
		return nil, e
	}
	if e = s.initializeAdmissionLiveState(); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) seal(kind, id string, v any) ([]byte, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return nil, e
	}
	return s.aead.Seal(nonce, nonce, b, []byte(kind+"/"+id)), nil
}
func (s *Store) open(kind, id string, b []byte, v any) error {
	n := s.aead.NonceSize()
	if len(b) < n {
		return fmt.Errorf("corrupt encrypted record")
	}
	p, e := s.aead.Open(nil, b[:n], b[n:], []byte(kind+"/"+id))
	if e != nil {
		return e
	}
	return json.Unmarshal(p, v)
}
func (s *Store) State() (State, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.state() }
func (s *Store) state() (State, error) {
	st := State{Nodes: []domain.Node{}, Users: []domain.User{}, Routes: []domain.Route{}, Revisions: []domain.Revision{}}
	rows, e := s.db.Query(`SELECT kind,id,data FROM records WHERE kind IN ('nodes','users','routes','revisions') ORDER BY kind,id`)
	if e != nil {
		return st, e
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		var b []byte
		if e = rows.Scan(&kind, &id, &b); e != nil {
			return st, e
		}
		switch kind {
		case "nodes":
			var v domain.Node
			e = s.open(kind, id, b, &v)
			st.Nodes = append(st.Nodes, v)
		case "users":
			var v domain.User
			e = s.open(kind, id, b, &v)
			st.Users = append(st.Users, v)
		case "routes":
			var v domain.Route
			e = s.open(kind, id, b, &v)
			st.Routes = append(st.Routes, v)
		case "revisions":
			var v domain.Revision
			e = s.open(kind, id, b, &v)
			st.Revisions = append(st.Revisions, v)
		}
		if e != nil {
			return st, e
		}
	}
	return st, rows.Err()
}
func (s *Store) PutNode(v domain.Node) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := domain.ValidateNode(v); e != nil {
		return e
	}
	v.Status = "unregistered"
	return s.put("nodes", v.ID, v)
}
func (s *Store) PutUser(v domain.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !domain.ValidID(v.ID) || v.Name == "" || v.QuotaBytes < 0 {
		return fmt.Errorf("valid id, name and non-negative quota required")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	var old domain.User
	if e = s.getTx(tx, "users", v.ID, &old); e != nil && e != ErrNotFound {
		return e
	}
	v.UsedBytes = old.UsedBytes
	if e = s.guardBudgetPolicyUpdate(tx, "users", v.ID, v, time.Now().UTC()); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) PutRoute(v domain.Route) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, e := s.state()
	if e != nil {
		return e
	}
	if e = domain.ValidateRoute(v, st.Nodes); e != nil {
		return e
	}
	if _, e = domain.SubscriptionName(v, st.Nodes); e != nil {
		return e
	}
	users := map[string]bool{}
	for _, u := range st.Users {
		users[u.ID] = true
	}
	seen := map[string]bool{}
	for _, id := range v.UserIDs {
		if !users[id] || seen[id] {
			return fmt.Errorf("unknown or duplicate user %s", id)
		}
		seen[id] = true
	}
	return s.put("routes", v.ID, v)
}
func (s *Store) Delete(kind, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind != "nodes" && kind != "users" && kind != "routes" {
		return fmt.Errorf("unsupported resource")
	}
	st, e := s.state()
	if e != nil {
		return e
	}
	for _, r := range st.Routes {
		refs := r.Hops
		if kind == "users" {
			refs = r.UserIDs
		}
		if kind != "routes" {
			for _, ref := range refs {
				if ref == id {
					return fmt.Errorf("resource is referenced by route %s", r.ID)
				}
			}
		}
	}
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
func (s *Store) RecordRevision(v domain.Revision) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v.Status != "rendered" || v.NativeChecked || !domain.ValidID(v.ID) {
		return fmt.Errorf("only unverified rendered revisions supported")
	}
	b, e := s.seal("revisions", v.ID, v)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('revisions',?,?)`, v.ID, b)
	return e
}
