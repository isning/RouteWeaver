package store_test

import (
	"bytes"
	"context"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Backup publication is a lossless copy, not activation or a hidden legacy
// migration. A future daemon Open is a separate operation with startup limits.
func TestOfflineBackupFreshVerificationDoesNotExpandLegacyNotifications(t *testing.T) {
	key := bytes.Repeat([]byte{64}, 32)
	source, err := store.Open(filepath.Join(t.TempDir(), "source"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	legacy := notifications.DefaultState()
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	legacy.Events["retained"] = notifications.Event{EventID: "retained", RecipientID: "owner", Kind: "quota", Title: "Retained", Body: "synthetic", CreatedAt: now}
	if err = source.Put("notification-private", "state", legacy); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	limits := store.OfflineBackupLimits{MaxBytes: 1 << 20, MaxRows: 100, MaxRecordBytes: 16 << 10}
	target := filepath.Join(t.TempDir(), "restored")
	if err = store.RestoreBackupOfflineFresh(ctx, target, key, source, limits); err != nil {
		t.Fatal(err)
	}
	beforeRows := 0
	legacySeen := false
	expanded := false
	if err = store.WithOfflineBackupSource(ctx, target, key, func(s *store.Store) error {
		return s.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
			beforeRows++
			if f.Record != nil {
				legacySeen = legacySeen || f.Record.Kind == "notification-private"
				expanded = expanded || f.Record.Kind == "notification-events"
			}
			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}
	if !legacySeen || expanded {
		t.Fatal("backup verification implicitly migrated legacy rows")
	}
	// An explicitly separate normal startup migrates this small supported legacy
	// fixture. No claim extends backup DiskBytes to subsequent daemon operations.
	activated, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer activated.Close()
	state, err := activated.ReadNotifications()
	if err != nil || state.Events["retained"].Body != "synthetic" {
		t.Fatalf("separate supported startup lost notification: %v", err)
	}
	afterRows := 0
	legacySeen = false
	if err = activated.ExportBackupOffline(ctx, limits, func(f store.BackupFrame) error {
		afterRows++
		if f.Record != nil && f.Record.Kind == "notification-private" {
			legacySeen = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if legacySeen || afterRows <= beforeRows {
		t.Fatal("fixture did not demonstrate separate canonical expansion")
	}
}
