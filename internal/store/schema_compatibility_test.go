package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
	"routeweaver/internal/store"
)

func TestOpenRejectsUnsupportedSchemaWithoutRecordMutation(t *testing.T) {
	for name, mutation := range map[string]string{
		"future migration":         `INSERT INTO schema_migrations VALUES(999,'synthetic-future')`,
		"missing migration":        `DELETE FROM schema_migrations WHERE version=1`,
		"unknown table":            `CREATE TABLE future_only(value TEXT)`,
		"unknown record column":    `ALTER TABLE records ADD COLUMN future_value TEXT`,
		"unknown derived column":   `ALTER TABLE usage_windows ADD COLUMN future_value TEXT`,
		"generated record column":  `ALTER TABLE records ADD COLUMN future_generated TEXT GENERATED ALWAYS AS(kind || id) VIRTUAL`,
		"generated derived column": `ALTER TABLE usage_windows ADD COLUMN future_generated TEXT GENERATED ALWAYS AS(account) VIRTUAL`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.db")
			key := make([]byte, 32)
			s, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Put("audit", "keep", map[string]string{"value": "unchanged"}); err != nil {
				t.Fatal(err)
			}
			if err = s.Close(); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err = db.Exec(mutation); err != nil {
				t.Fatal(err)
			}
			var before []byte
			if err = db.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			reopened, openErr := store.Open(path, key)
			if openErr == nil {
				reopened.Close()
				t.Error("unsupported database must be rejected before initialization writes")
			}
			var after []byte
			if err = db.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Error("rejected Open changed an encrypted record")
			}
		})
	}
}

func TestOpenInitializesRecordsOnlyLegacyDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id))`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := store.Open(path, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("audit", "legacy-write", map[string]bool{"ok": true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestReadinessRejectsUnsupportedLiveSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, err := store.Open(path, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`INSERT INTO schema_migrations VALUES(999,'synthetic-future')`); err != nil {
		t.Fatal(err)
	}
	if err = s.Ready(context.Background()); err == nil {
		t.Fatal("readiness accepted an unsupported live schema")
	}
}

func TestOpenMigratesSupportedHistoricalSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	key := make([]byte, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Put("audit", "keep", map[string]string{"value": "unchanged"}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DELETE FROM schema_migrations WHERE version=2`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var got map[string]string
	if err = s.Get("audit", "keep", &got); err != nil || got["value"] != "unchanged" {
		t.Fatalf("historical data lost: %v %v", got, err)
	}
	if err = s.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentFirstOpenPreservesSchemaInitialization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	start := make(chan struct{})
	errs := make(chan error, 4)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			s, err := store.Open(path, make([]byte, 32))
			if err == nil {
				err = s.Close()
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent initialization: %v", err)
		}
	}
}
