package store_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestOfflineBackupReviewRejectsHardlinkMissingCommittedWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{55}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias.db")
	if err = os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("ledger", "committed-wal", map[string]int{"value": 19}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	seen := false
	called := false
	err = store.WithOfflineBackupSource(ctx, alias, key, func(source *store.Store) error {
		called = true
		return source.ExportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}, func(f store.BackupFrame) error {
			if f.Record != nil && f.Record.ID == "committed-wal" {
				seen = true
			}
			return nil
		})
	})
	if err == nil || !strings.Contains(err.Error(), "exactly one filesystem link") || called {
		t.Fatalf("hardlink not refused before callback: called=%v err=%v", called, err)
	}
	if err = os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	err = store.WithOfflineBackupSource(ctx, alias, key, func(source *store.Store) error {
		return source.ExportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}, func(f store.BackupFrame) error {
			if f.Record != nil && f.Record.ID == "committed-wal" {
				seen = true
			}
			return nil
		})
	})
	if err != nil || !seen {
		t.Fatalf("canonical symlink missed committed WAL: seen=%v err=%v", seen, err)
	}
}
