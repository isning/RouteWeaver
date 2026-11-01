package store

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
)

// readSnapshot keeps history scans off the writer connection and Store mutex.
// The callback consumes a single SQLite snapshot; no pagination across changing
// snapshots or partial result can be confused with a complete history.
func (s *Store) readSnapshot(ctx context.Context, consume func(*sql.Tx) error) error {
	// A long snapshot must not hold the Store mutex or its sole writable
	// connection: admission lease renewal and normal writes remain available.
	// The existing connection is borrowed only to resolve its SQLite filename.
	var path string
	if err := s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		return err
	}
	if path == "" {
		return errors.New("history read requires a file-backed store")
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
	if err = consume(tx); err != nil {
		return err
	}
	return tx.Commit()
}
