package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestOfflineBackupReviewCommittedWALVisibleWithoutSourceRewrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{47}, 32)
	writer, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err = writer.Put("ledger", "wal-only", map[string]int{"value": 17}); err != nil {
		t.Fatal(err)
	}
	before := map[string][32]byte{}
	for _, suffix := range []string{"", "-wal"} {
		b, err := os.ReadFile(path + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if suffix == "-wal" && len(b) == 0 {
			t.Fatal("fixture has no WAL")
		}
		before[suffix] = sha256.Sum256(b)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	seen := false
	err = store.WithOfflineBackupSource(ctx, path, key, func(s *store.Store) error {
		if err := s.Put("ledger", "forbidden", map[string]int{"value": 1}); err == nil {
			t.Fatal("source allowed writes")
		}
		return s.ExportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}, func(f store.BackupFrame) error {
			if f.Record != nil && f.Record.ID == "wal-only" {
				seen = true
			}
			return nil
		})
	})
	if err != nil || !seen {
		t.Fatalf("committed WAL not exported: seen=%v err=%v", seen, err)
	}
	for suffix, hash := range before {
		b, err := os.ReadFile(path + suffix)
		if err != nil || sha256.Sum256(b) != hash {
			t.Fatalf("source %s changed: %v", suffix, err)
		}
	}
}

func TestOfflineBackupReviewPreservesProviderFenceAndRejectsOmission(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{50}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("hosts", "transit-node", domain.Host{ID: "transit-node", Name: "Host"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("core-instances", "core", domain.CoreInstance{ID: "core", HostID: "transit-node", AdapterID: "routeweaver/managed-xray"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := s.ConfigureNodeObservations("transit-node", suspensionConfig(now)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	key := bytes.Repeat([]byte{49}, 32)
	privateDir := t.TempDir()
	if err = os.Chmod(privateDir, 0700); err != nil {
		t.Fatal(err)
	}
	fresh, err := store.OpenOfflineBackupStage(filepath.Join(privateDir, "rejected.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	limits := store.OfflineBackupLimits{MaxBytes: 2 << 20, MaxRows: 1000, MaxRecordBytes: 32 << 10}
	err = fresh.ImportBackupOffline(ctx, limits, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
			if f.Migration != nil && f.Migration.Version == 3 {
				return nil
			}
			return emit(f)
		})
	})
	if err == nil || !strings.Contains(err.Error(), "provider admission policy requires its migration fence") {
		t.Fatalf("want explicit missing provider fence rejection, got %v", err)
	}
	if _, err = fresh.NodeObservations("transit-node"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rejected policy persisted: %v", err)
	}
	l := backup.SetLimits{TotalBytes: 2 << 20, TotalRows: 1000, PartBytes: 64 << 10, PartRows: 2, RecordBytes: 32 << 10, Parts: 256, Duration: time.Minute, DiskBytes: 256 << 20}
	set := filepath.Join(t.TempDir(), "set")
	const password = "synthetic-review-backup-passphrase"
	if err = backup.CreateSet(ctx, s, password, set, l); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	if err = backup.RestoreSet(ctx, set, password, target, key, l); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	seen := false
	if err = restored.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
		if f.Migration != nil && f.Migration.Version == 3 {
			seen = true
		}
		return nil
	}); err != nil || !seen {
		t.Fatalf("lost migration 3: seen=%v err=%v", seen, err)
	}
	state, err := restored.NodeObservations("transit-node")
	if err != nil || state.Config.Provider == nil || state.Config.Provider.ExhaustionAction != "suspend-managed" {
		t.Fatalf("lost policy: %v", err)
	}
}
