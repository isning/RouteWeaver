package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// RestoreBackupFresh never opens attacker-controlled SQLite. It imports logical
// rows into a new encrypted store, closes it, reopens without materializing State,
// verifies a canonical streamed digest, and publishes with no-replace semantics.
func RestoreBackupFresh(ctx context.Context, target string, key []byte, source *Store, l BackupLimits) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(target) || len(key) != 32 {
		return errors.New("absolute restore target and 32-byte master key required")
	}
	canonical, err := freshDatabaseTarget(target)
	if err != nil {
		return err
	}
	target = canonical
	if source == nil {
		return errors.New("restore source required")
	}
	var sourcePath string
	if err = source.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&sourcePath); err != nil {
		return err
	}
	if sourcePath != "" {
		sourcePath, err = CanonicalDatabasePath(sourcePath)
		if err != nil {
			return err
		}
		if err = rejectSourceSQLitePathFamily(sourcePath, target); err != nil {
			return err
		}
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
	defer func() { s.Close() }()
	before := sha256.New()
	err = s.ImportBackup(ctx, l, func(emit func(BackupFrame) error) error {
		return source.ExportBackup(ctx, l, func(f BackupFrame) error {
			if err := json.NewEncoder(before).Encode(f); err != nil {
				return err
			}
			return emit(f)
		})
	})
	if err != nil {
		return err
	}
	if _, err = s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	if err = s.Close(); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	s, err = newStore(db, key)
	if err != nil {
		db.Close()
		return err
	}
	after := sha256.New()
	if err = s.ExportBackup(ctx, l, func(f BackupFrame) error { return json.NewEncoder(after).Encode(f) }); err != nil {
		return err
	}
	if string(before.Sum(nil)) != string(after.Sum(nil)) {
		return errors.New("restored streaming verification mismatch")
	}
	if _, err = s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	if err = s.Close(); err != nil {
		return err
	}
	return publishFreshBackup(ctx, path, target)
}

// ErrRestorePublicationUncertain means a new target was linked, but its final
// durability or cleanup could not be established. It never means live activation.
var ErrRestorePublicationUncertain = errors.New("restore publication outcome is uncertain")

// RestorePublicationUncertainError retains local filesystem causes without
// exposing paths through Error. Callers must not interpret it as no new target.
type RestorePublicationUncertainError struct {
	Err error
}

func (e *RestorePublicationUncertainError) Error() string {
	return ErrRestorePublicationUncertain.Error()
}
func (e *RestorePublicationUncertainError) Unwrap() error { return e.Err }
func (e *RestorePublicationUncertainError) Is(target error) bool {
	return target == ErrRestorePublicationUncertain
}

// Per-call operations keep publication faults deterministic in package tests;
// callers of the public restore functions always use the real filesystem.
type backupPublicationOps struct {
	link       func(string, string) error
	syncParent func(string) error
	remove     func(string) error
}

func syncBackupParent(target string) error {
	parent, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	return syncAndCloseBackupParent(parent.Sync, parent.Close)
}

// A successful directory sync establishes durability. A later close error must
// not trigger removal of the committed target; preserve the original semantics.
func syncAndCloseBackupParent(sync, close func() error) error {
	err := sync()
	close()
	return err
}

// Called only after durable-close and logical verification. Link never replaces
// an occupied filename or symlink, unlike Rename.
func publishFreshBackup(ctx context.Context, path, target string) error {
	return publishFreshBackupWithOps(ctx, path, target, backupPublicationOps{
		link: os.Link, syncParent: syncBackupParent, remove: os.Remove,
	})
}

func publishFreshBackupWithOps(ctx context.Context, path, target string, ops backupPublicationOps) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Recheck after copy, verification and fsync: a sidecar may have appeared
	// since admission. Do not remove it, or report uncertain publication when
	// no link has yet been attempted.
	canonical, err := freshDatabaseTarget(target)
	if err != nil {
		return err
	}
	target = canonical
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = ops.link(path, target); err != nil {
		return err
	}
	if err = ops.syncParent(target); err != nil {
		// Even successful unlink is not proof of durable rollback. Preserve the
		// uncertainty and both local errors; the HTTP layer must not invite retry.
		return &RestorePublicationUncertainError{Err: errors.Join(err, ops.remove(target))}
	}
	// Link and directory sync established publication. Context expiry during
	// those noninterruptible calls must not turn durable success into failure.
	return nil
}
