package store_test

import (
	"bytes"
	"context"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestOfflineBackupReviewLogicalByteBudget(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source"), bytes.Repeat([]byte{51}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	emitted := 0
	err = s.ExportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1, MaxRows: 100, MaxRecordBytes: 8192}, func(store.BackupFrame) error { emitted++; return nil })
	if err == nil {
		t.Fatalf("logical MaxBytes=1 accepted complete %d-frame backup", emitted)
	}
}

func TestOfflineBackupReviewImportLogicalByteBudget(t *testing.T) {
	key := bytes.Repeat([]byte{52}, 32)
	s, err := store.Open(filepath.Join(t.TempDir(), "source"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	target, err := store.OpenOfflineBackupStage(privateOfflineStagePath(t, "target"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	err = target.ImportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1, MaxRows: 100, MaxRecordBytes: 8192}, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackupOffline(ctx, store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 8192}, emit)
	})
	if err == nil || !strings.Contains(err.Error(), "canonical byte budget") {
		t.Fatalf("logical MaxBytes=1 import did not fail at byte guard: %v", err)
	}
}
