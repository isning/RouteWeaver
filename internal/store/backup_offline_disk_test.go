package store

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOfflineBackupPrivateJournalAndLogicalBudget(t *testing.T) {
	key := bytes.Repeat([]byte{61}, 32)
	source, err := Open(filepath.Join(t.TempDir(), "source"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	for _, id := range []string{"a", "b", "c"} {
		if err = source.Put("ledger", id, map[string]string{"data": strings.Repeat("x", 8192)}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	limits := OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 16 << 10}
	var bytesNeeded int64
	if err = source.ExportBackupOffline(ctx, limits, func(f BackupFrame) error { b, e := json.Marshal(f); bytesNeeded += int64(len(b)) + 1; return e }); err != nil {
		t.Fatal(err)
	}
	private, err := os.MkdirTemp(t.TempDir(), "private-")
	if err != nil {
		t.Fatal(err)
	}
	stagePath := filepath.Join(private, "stage")
	stage, err := OpenOfflineBackupStage(stagePath, key)
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()
	produce := func(emit func(BackupFrame) error) error {
		return source.ExportBackupOffline(ctx, limits, func(f BackupFrame) error {
			if err := emit(f); err != nil {
				return err
			}
			for _, suffix := range []string{"-wal", "-shm", "-journal"} {
				if _, err := os.Lstat(stagePath + suffix); !os.IsNotExist(err) {
					t.Fatalf("disk journal appeared: %s %v", suffix, err)
				}
			}
			info, err := os.Stat(stagePath)
			if err != nil {
				return err
			}
			if info.Size() > 2*limits.MaxBytes+(16<<20) {
				t.Fatal("main exceeded page envelope")
			}
			return nil
		})
	}
	tight := limits
	tight.MaxBytes = bytesNeeded - 1
	if err = stage.ImportBackupOffline(ctx, tight, produce); err == nil || !strings.Contains(err.Error(), "canonical byte budget") {
		t.Fatalf("underbudget import: %v", err)
	}
	exact := limits
	exact.MaxBytes = bytesNeeded
	if err = stage.ImportBackupOffline(ctx, exact, produce); err != nil {
		t.Fatalf("exact-byte retry after rollback: %v", err)
	}
	var mode string
	if err = stage.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "memory" {
		t.Fatalf("mode %q: %v", mode, err)
	}
	var pageSize, maxPages int64
	stage.db.QueryRow(`PRAGMA page_size`).Scan(&pageSize)
	stage.db.QueryRow(`PRAGMA max_page_count`).Scan(&maxPages)
	if maxPages > (2*exact.MaxBytes+(16<<20))/pageSize {
		t.Fatal("page cap missing")
	}
}

func TestOfflineBackupRejectsOrdinaryStoreBeforeJournalMutation(t *testing.T) {
	key := bytes.Repeat([]byte{62}, 32)
	s, err := Open(filepath.Join(t.TempDir(), "ordinary"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	called := false
	err = s.ImportBackupOffline(ctx, OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}, func(func(BackupFrame) error) error { called = true; return nil })
	if err == nil || called || !strings.Contains(err.Error(), "private stage capability") {
		t.Fatalf("ordinary object admitted: %v", err)
	}
	var mode string
	if err = s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("ordinary journal changed %q %v", mode, err)
	}
}

func TestOfflineBackupStageNeverReopensExistingOrPublicParent(t *testing.T) {
	key := bytes.Repeat([]byte{63}, 32)
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "stage")
	s, err := OpenOfflineBackupStage(path, key)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if reopened, err := OpenOfflineBackupStage(path, key); err == nil {
		reopened.Close()
		t.Fatal("resumed prior stage")
	}
	if err = os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if opened, err := OpenOfflineBackupStage(filepath.Join(dir, "other"), key); err == nil {
		opened.Close()
		t.Fatal("accepted non-private parent")
	}
}
