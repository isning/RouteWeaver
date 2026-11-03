package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const sqliteBusyTimeout = 5 * time.Second

// WAL mode negotiation needs an exclusive lock before migrate can reserve the
// writer. SQLite may return BUSY without invoking its busy handler when two
// first-open connections try to upgrade their read locks. Retry only this
// idempotent statement, after Scan has finalized it and released its locks.
// Neither the schema preflight nor any migration transaction is replayed here.
func enableWAL(ctx context.Context, db *sql.DB) (err error) {
	ctx, cancel := context.WithTimeout(ctx, sqliteBusyTimeout)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Own the wait budget here rather than stacking a fresh SQLite timeout on
	// every attempt. Restore the normal writer timeout on this same connection.
	if _, err = conn.ExecContext(ctx, `PRAGMA busy_timeout=0`); err != nil {
		return err
	}
	defer func() {
		_, restoreErr := conn.ExecContext(context.Background(), `PRAGMA busy_timeout=5000`)
		err = errors.Join(err, restoreErr)
	}()
	var busy error
	for {
		if err = ctx.Err(); err != nil {
			return errors.Join(err, busy)
		}
		var mode string
		err = conn.QueryRowContext(ctx, `PRAGMA journal_mode=WAL`).Scan(&mode)
		if err == nil {
			if mode != "wal" {
				return fmt.Errorf("SQLite did not enable WAL mode (returned %q)", mode)
			}
			return ctx.Err()
		}
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), busy, err)
		}
		var code interface{ Code() int }
		if !errors.As(err, &code) || code.Code()&255 != 5 { // SQLITE_BUSY, including extended busy codes
			return err
		}
		busy = err
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errors.Join(ctx.Err(), busy)
		case <-timer.C:
		}
	}
}
