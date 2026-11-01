package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestOfflineBackupSourceReadOnlyLockAndConsistentSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{29}, 32)
	s, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Put("ledger", "a", map[string]int{"value": 1}); e != nil {
		t.Fatal(e)
	}
	s.Close()
	before, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	limits := store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}
	e = store.WithOfflineBackupSource(ctx, path, key, func(src *store.Store) error {
		// The same CP lock must remain held for the complete callback.
		release, err := store.AcquireDatabaseProcessLock(path)
		if err == nil {
			release()
			t.Fatal("source callback did not hold process lock")
		}
		return src.ExportBackupOffline(ctx, limits, func(store.BackupFrame) error { return nil })
	})
	if e != nil {
		t.Fatal(e)
	}
	after, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("offline read rewrote source")
	}
	// A deadline is mandatory; ordinary online entry points retain their ceilings.
	if e = store.WithOfflineBackupSource(context.Background(), path, key, func(*store.Store) error { return nil }); e == nil {
		t.Fatal("unbounded offline read")
	}
	s, e = store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.ExportBackup(ctx, store.BackupLimits{MaxBytes: 2 << 30, MaxRows: 100, MaxRecordBytes: 8192}, func(store.BackupFrame) error { return nil }); e == nil {
		t.Fatal("online cap widened")
	}
	// The offline seam accepts explicit finite budgets beyond the online guard,
	// without creating a two-million-row fixture or increasing online bounds.
	larger := store.OfflineBackupLimits{MaxBytes: 2 << 30, MaxRows: 2000001, MaxRecordBytes: 8192}
	if e = s.ExportBackupOffline(ctx, larger, func(store.BackupFrame) error { return nil }); e != nil {
		t.Fatal(e)
	}
	mutated := false
	seen := false
	e = s.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
		if !mutated {
			mutated = true
			if err := s.Put("ledger", "later", map[string]int{"value": 2}); err != nil {
				return err
			}
		}
		if f.Record != nil && f.Record.ID == "later" {
			seen = true
		}
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	if !mutated || seen {
		t.Fatal("export did not retain one snapshot")
	}
}
func TestOfflineBackupImportRollbackCanRestart(t *testing.T) {
	key := bytes.Repeat([]byte{35}, 32)
	s, e := store.Open(filepath.Join(t.TempDir(), "source"), key)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	target, e := store.OpenOfflineBackupStage(privateOfflineStagePath(t, "stage"), key)
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	limits := store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}
	sentinel := errors.New("interrupted part")
	e = target.ImportBackupOffline(ctx, limits, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
			if err := emit(f); err != nil {
				return err
			}
			return sentinel
		})
	})
	if !errors.Is(e, sentinel) {
		t.Fatalf("partial error: %v", e)
	}
	if e = target.ImportBackupOffline(ctx, limits, func(emit func(store.BackupFrame) error) error { return s.ExportBackupOffline(ctx, limits, emit) }); e != nil {
		t.Fatalf("clean restart after rollback: %v", e)
	}
}

func privateOfflineStagePath(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp(t.TempDir(), "private-")
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, name)
}

func TestOfflineBackupRejectsHardlinkWALAlias(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "source.db")
	alias := filepath.Join(dir, "alias.db")
	key := bytes.Repeat([]byte{38}, 32)
	source, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	source.Close()
	if err = os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	source, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.Put("ledger", "committed-only-in-wal", map[string]int{"value": 1}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for _, candidate := range []string{path, alias} {
		called := false
		err = store.WithOfflineBackupSource(ctx, candidate, key, func(*store.Store) error { called = true; return nil })
		if err == nil || called {
			t.Fatalf("accepted multiply linked source %s: %v", candidate, err)
		}
	}
}
