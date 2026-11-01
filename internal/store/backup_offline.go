package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OfflineBackupLimits is a separate, explicitly budgeted maintenance seam. It
// does not increase the online single-archive limits. A finite deadline is
// mandatory. MaxBytes bounds cumulative canonical JSON-frame bytes (including
// newlines and indexes); the adapter separately bounds ciphertext. Offline
// import uses MEMORY rollback journals exclusively on fresh private databases,
// with main-file page count bounded by 2*MaxBytes+16MiB. Interrupted private
// stages are discarded, never resumed as crash-recoverable databases.
type OfflineBackupLimits struct {
	MaxBytes       int64
	MaxRows        int
	MaxRecordBytes int
}

func (l OfflineBackupLimits) checked(ctx context.Context) (BackupLimits, error) {
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 6*time.Hour || l.MaxBytes < 1 || l.MaxBytes > 32<<30 || l.MaxRows < 1 || l.MaxRows > 64000000 || l.MaxRecordBytes < 1 || l.MaxRecordBytes > 128<<20 {
		return BackupLimits{}, errors.New("offline backup requires a deadline within 6h and explicit limits within 32GiB, 64000000 rows, 128MiB per record")
	}
	if err := ctx.Err(); err != nil {
		return BackupLimits{}, err
	}
	return BackupLimits{MaxBytes: l.MaxBytes, MaxRows: l.MaxRows, MaxRecordBytes: l.MaxRecordBytes}, nil
}
func (s *Store) ExportBackupOffline(ctx context.Context, l OfflineBackupLimits, emit func(BackupFrame) error) error {
	b, err := l.checked(ctx)
	if err != nil {
		return err
	}
	return s.exportBackup(ctx, b, offlineByteBound(l.MaxBytes, emit))
}

// OpenOfflineBackupStage creates a new database in a private owned directory.
// Only this capability can use memory-journal import; ordinary/live Store.Open
// objects cannot be switched into the less crash-recoverable staging mode.
// A crashed stage must be discarded, never resumed or activated.
func OpenOfflineBackupStage(path string, key []byte) (*Store, error) {
	if !filepath.IsAbs(path) || len(key) != 32 {
		return nil, errors.New("absolute private stage path and 32-byte key required")
	}
	parent, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if !parent.IsDir() || parent.Mode().Perm()&0077 != 0 {
		return nil, errors.New("offline stage parent must be private")
	}
	if err = requireAbsentSQLitePathFamily(path); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	s, err := Open(path, key)
	if err != nil {
		return nil, err
	}
	s.offlineBackupPrivate = true
	return s, nil
}

func (s *Store) ImportBackupOffline(ctx context.Context, l OfflineBackupLimits, produce func(func(BackupFrame) error) error) error {
	b, err := l.checked(ctx)
	if err != nil {
		return err
	}
	return s.importBackupMode(ctx, b, func(emit func(BackupFrame) error) error { return produce(offlineByteBound(l.MaxBytes, emit)) }, true)
}
func RestoreBackupOfflineFresh(ctx context.Context, target string, key []byte, source *Store, l OfflineBackupLimits) error {
	b, err := l.checked(ctx)
	if err != nil {
		return err
	}
	return restoreBackupFresh(ctx, target, key, source, b, true)
}

// WithOfflineBackupSource holds the same inode lock as the control plane. Unlike
// Open, it never initializes, migrates, checkpoints, or rewrites source data.
// SQLite's read-only connection includes committed WAL pages (not immutable=1).
// The callback must not retain the Store after returning.
func WithOfflineBackupSource(ctx context.Context, path string, key []byte, consume func(*Store) error) error {
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("offline backup source requires a deadline")
	}
	if len(key) != 32 {
		return errors.New("32-byte master key required")
	}
	canonical, err := CanonicalDatabasePath(path)
	if err != nil {
		return err
	}
	before, err := os.Stat(canonical)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return errors.New("source must be regular database file")
	}
	if err = requireSingleLinkBackupSource(before); err != nil {
		return err
	}
	release, err := AcquireDatabaseProcessLock(canonical)
	if err != nil {
		return err
	}
	defer release()
	after, err := os.Stat(canonical)
	if err != nil {
		return err
	}
	if err = requireSingleLinkBackupSource(after); err != nil {
		return err
	}
	if !os.SameFile(before, after) {
		return errors.New("source changed while acquiring database lock")
	}
	uri := (&url.URL{Scheme: "file", Path: canonical, RawQuery: "mode=ro"}).String()
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	s, err := newStore(db, key)
	if err != nil {
		return err
	}
	return consume(s)
}

// backupDiskCheck supplements SQLite's incremental max_page_count guard with
// real main/WAL/journal/SHM file growth observations. These are not free-space
// measurements or an OS disk quota. Any unknown filesystem error fails closed.
func (s *Store) backupDiskCheck(ctx context.Context, max int64) (func() error, error) {
	var path string
	if err := s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("backup staging requires a file-backed database")
	}
	return func() error {
		var total int64
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			info, err := os.Lstat(path + suffix)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("unexpected backup staging file type")
			}
			if info.Size() > max-total {
				return errors.New("backup staging disk budget exceeded")
			}
			total += info.Size()
		}
		return nil
	}, nil
}

// Count the exact canonical frame bytes at both offline store seams; metadata,
// indexes and migrations are included, not merely record payloads.
func offlineByteBound(max int64, emit func(BackupFrame) error) func(BackupFrame) error {
	var used int64
	return func(f BackupFrame) error {
		b, err := json.Marshal(f)
		if err != nil {
			return err
		}
		n := int64(len(b)) + 1
		clear(b)
		if n > max-used {
			return errors.New("offline backup canonical byte budget exceeded")
		}
		used += n
		return emit(f)
	}
}

// The caller holds s.mu and owns a fresh private file. A MEMORY rollback journal
// cannot spill to disk: unlike WAL, repeated dirty-page writes cannot accumulate
// additional disk frames outside max_page_count. Only pre-transaction pages need
// rollback images, and this original database is limited to 1MiB. A process crash
// may leave its private main inconsistent; callers must discard the owned stage.
func (s *Store) prepareOfflineBackupImport(ctx context.Context, l BackupLimits) (func() error, error) {
	if !s.offlineBackupPrivate {
		return nil, errors.New("offline import requires private stage capability")
	}
	var occupied int
	if err := s.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM records WHERE NOT (kind='metadata' AND id='key-check'))+(SELECT count(*) FROM identities)+(SELECT count(*) FROM token_index)+(SELECT count(*) FROM counters)`).Scan(&occupied); err != nil {
		return nil, err
	}
	if occupied != 0 {
		return nil, errors.New("offline import requires fresh private staging")
	}
	initial, err := s.backupDiskCheck(ctx, 2<<20)
	if err != nil {
		return nil, err
	}
	if err = initial(); err != nil {
		return nil, err
	}
	var pageSize, pages int64
	if err = s.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return nil, err
	}
	if err = s.db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pages); err != nil {
		return nil, err
	}
	if pageSize < 512 || pageSize > 65536 || pages > (1<<20)/pageSize {
		return nil, errors.New("offline initial database exceeds bounded rollback memory")
	}
	var mode string
	if err = s.db.QueryRowContext(ctx, `PRAGMA journal_mode=MEMORY`).Scan(&mode); err != nil {
		return nil, err
	}
	if mode != "memory" {
		return nil, errors.New("offline private journal mode unavailable")
	}
	var path string
	if err = s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		return nil, err
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err = os.Lstat(path + suffix); !os.IsNotExist(err) {
			return nil, errors.New("offline private stage retains unexpected disk journal")
		}
	}

	if _, err = s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA temp_store=MEMORY; PRAGMA max_page_count=%d", (2*l.MaxBytes+(16<<20))/pageSize)); err != nil {
		return nil, err
	}
	var actual int64
	if err = s.db.QueryRowContext(ctx, `PRAGMA max_page_count`).Scan(&actual); err != nil {
		return nil, err
	}
	if actual > (2*l.MaxBytes+(16<<20))/pageSize {
		return nil, errors.New("offline page-count limit not installed")
	}
	check, err := s.backupDiskCheck(ctx, 2*l.MaxBytes+(16<<20))
	if err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		return nil, err
	}
	return check, nil
}

// ValidateBackupDestination rejects canonical source main/sidecar aliases even
// when a sidecar is currently absent. A directory must never occupy a future WAL
// or journal filename and make the unchanged source database unusable.
func (s *Store) ValidateBackupDestination(ctx context.Context, target string) error {
	var path string
	if err := s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		return err
	}
	source, err := CanonicalDatabasePath(path)
	if err != nil {
		return err
	}
	output, err := CanonicalDatabasePath(target)
	if err != nil {
		return err
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if err = requireSingleLinkBackupSource(info); err != nil {
		return err
	}
	for _, suffix := range sqliteDatabasePathSuffixes {
		if strings.HasPrefix(output, source+suffix+string(filepath.Separator)) {
			return errors.New("destination must not descend into a source database or SQLite sidecar path")
		}
	}
	return rejectSourceSQLitePathFamily(source, output)
}
