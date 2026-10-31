package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *Store) beginNotificationWriteTx(ctx context.Context) (*sql.Tx, error) {
	if ctx == nil {
		return s.beginWriteTx()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	var original int
	if err = tx.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&original); err != nil {
		tx.Rollback()
		return nil, err
	}
	restore := fmt.Sprintf("PRAGMA busy_timeout=%d", original)
	fail := func(cause error) (*sql.Tx, error) {
		tx.Rollback()
		// busy_timeout is connection-local, not transactional. Restore even when
		// context cancellation already rolled the transaction back.
		_, restoreErr := s.db.Exec(restore)
		return nil, errors.Join(cause, restoreErr)
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	for {
		if err = ctx.Err(); err != nil {
			return fail(err)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fail(context.DeadlineExceeded)
		}
		wait := remaining.Milliseconds()
		if wait > 100 {
			wait = 100
		}
		if wait < 1 {
			wait = 1
		}
		// SQLite busy_timeout may otherwise outlive the Go context by five seconds.
		// Bound each reservation attempt and retry without any prior snapshot read.
		if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", wait)); err != nil {
			return fail(err)
		}
		_, err = tx.ExecContext(ctx, `UPDATE counters SET value=value WHERE kind='admission-lock'`)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		var sqliteCode interface{ Code() int }
		if !errors.As(err, &sqliteCode) || (sqliteCode.Code()&255 != 5 && sqliteCode.Code()&255 != 6) {
			return fail(err)
		}
		timer := time.NewTimer(5 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fail(ctx.Err())
		case <-timer.C:
		}
	}
	if _, err = tx.ExecContext(ctx, restore); err != nil {
		return fail(err)
	}
	return tx, nil
}

// Notification worker/read budgets include waiting behind another Store
// operation; a cancelled tick must not leak a goroutine waiting on the mutex.
func (s *Store) lockNotificationContext(ctx context.Context) error {
	if ctx == nil {
		s.mu.Lock()
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.mu.TryLock() {
		if err := ctx.Err(); err != nil {
			s.mu.Unlock()
			return err
		}
		return nil
	}
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			if s.mu.TryLock() {
				if err := ctx.Err(); err != nil {
					s.mu.Unlock()
					return err
				}
				return nil
			}
		}
	}
}
