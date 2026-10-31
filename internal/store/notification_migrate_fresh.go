package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"modernc.org/sqlite"
)

// MigrateNotificationsFresh is an offline, opt-in migration into a NEW path.
// It never opens the source through Store.Open. The shared control-plane inode
// lock remains held through publication; a read-only SQLite snapshot includes
// committed WAL pages. Only an owned temporary copy is initialized/migrated.
// The caller must supply an operation deadline and adequate memory/disk budget.
// Success does not activate the result or change any running service's path.
func MigrateNotificationsFresh(ctx context.Context, source, target string, key []byte, maxRecordBytes int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("offline migration requires an operation deadline")
	}
	if len(key) != 32 || maxRecordBytes < 1 || maxRecordBytes > MaxOfflineLegacyNotificationBytes {
		return errors.New("32-byte master key and explicit legacy record limit in 1–268435456 bytes required")
	}
	// Existing SQLite sidecars are occupied output too: publishing a new main
	// file alongside an unrelated WAL/hot journal is not a fresh database.
	if err := requireAbsentSQLitePathFamily(target); err != nil {
		return err
	}
	src, err := CanonicalDatabasePath(source)
	if err != nil {
		return err
	}
	dst, err := CanonicalDatabasePath(target)
	if err != nil {
		return err
	}
	if err = rejectSourceSQLitePathFamily(src, dst); err != nil {
		return err
	}
	if err = requireAbsentSQLitePathFamily(dst); err != nil {
		return err
	}
	before, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return errors.New("migration source must be an existing regular database file")
	}
	release, err := AcquireDatabaseProcessLock(src)
	if err != nil {
		return err
	}
	defer release()
	locked, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !os.SameFile(before, locked) {
		return errors.New("migration source identity changed while acquiring lock")
	}
	uri := url.URL{Scheme: "file", Path: src}
	params := url.Values{"mode": {"ro"}}
	uri.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Pin one read snapshot for validation AND all online-backup steps. Do not use
	// immutable=1: that would ignore a stopped database's outstanding WAL pages.
	if _, err = conn.ExecContext(ctx, `BEGIN`); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), `ROLLBACK`)
	if err = validateExistingSchema(ctx, conn); err != nil {
		return unsupportedSchema(err)
	}
	crypto, err := newStore(db, key)
	if err != nil {
		return err
	}
	if err = validateNotificationMigrationSource(ctx, conn, int64(crypto.aead.NonceSize()+crypto.aead.Overhead()), maxRecordBytes); err != nil {
		return err
	}
	// No directory or temporary file is created until source preflight succeeds.
	dir, err := os.MkdirTemp(filepath.Dir(dst), ".notification-migrate-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	copyPath := filepath.Join(dir, "source-copy.db")
	if err = copyNotificationMigrationSnapshot(ctx, conn, copyPath); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	migrated, err := openStoreWithNotificationLimit(copyPath, key, maxRecordBytes)
	if err != nil {
		return err
	}
	defer migrated.Close()
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = requireAbsentSQLitePathFamily(dst); err != nil {
		return err
	}
	return RestoreBackupFresh(ctx, dst, key, migrated, BackupLimits{MaxRecordBytes: 32 << 20, MaxBytes: 1 << 30, MaxRows: 2000000})
}

func validateNotificationMigrationSource(ctx context.Context, conn *sql.Conn, overhead, legacyLimit int64) error {
	// Read lengths/boolean identity, never the potentially oversized encrypted
	// legacy payload. Bound the metadata walk before creating the physical copy.
	rows, err := conn.QueryContext(ctx, `SELECT length(kind),length(id),length(data),kind='notification-private' AND id='state' FROM records LIMIT 2000001`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var count, total int64
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			return err
		}
		var kindLen, idLen, n int64
		var legacy bool
		if err = rows.Scan(&kindLen, &idLen, &n, &legacy); err != nil {
			return err
		}
		count++
		if count > 2000000 || kindLen < 1 || kindLen > 4096 || idLen < 1 || idLen > 4096 || n < overhead {
			return errors.New("source records exceed offline migration limits")
		}
		limit := int64(32 << 20)
		if legacy {
			limit = legacyLimit
		}
		if n > limit+overhead {
			return fmt.Errorf("source record exceeds reviewed migration byte limit")
		}
		total += n - overhead
		if total > 1<<30 {
			return errors.New("source records exceed offline migration total byte limit")
		}
	}
	return rows.Err()
}

func copyNotificationMigrationSnapshot(ctx context.Context, conn *sql.Conn, path string) error {
	return conn.Raw(func(raw any) (err error) {
		driver, ok := raw.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return errors.New("SQLite online backup capability unavailable")
		}
		backup, err := driver.NewBackup(path)
		if err != nil {
			return err
		}
		defer func() { err = errors.Join(err, backup.Finish()) }()
		for {
			if err = ctx.Err(); err != nil {
				return err
			}
			more, e := backup.Step(128)
			if e != nil {
				return e
			}
			if !more {
				return ctx.Err()
			}
		}
	})
}
