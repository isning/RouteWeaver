package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestAcceptedNotificationsRemainBackupRecoverable(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n := notifications.New(s, nil)
	now := time.Date(2026, 10, 31, 12, 0, 0, 123456789, time.UTC)
	for i := 0; i < 10; i++ {
		if err = n.SaveAnnouncement(notifications.Announcement{ID: fmt.Sprintf("a%d", i), Title: "Announcement", Body: strings.Repeat("A", 8000), Audience: "all", StartsAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	recipients := make([]notifications.Recipient, 500)
	for i := range recipients {
		recipients[i] = notifications.Recipient{ID: fmt.Sprintf("user%d", i), Role: "user", Enabled: true}
	}
	if err = n.Evaluate(recipients, nil, now); err != nil {
		t.Fatal(err)
	}
	st, err := s.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("accepted announcements=%d recipients=%d events=%d deliveries=%d state bytes=%d", len(st.Announcements), len(recipients), len(st.Events), len(st.Deliveries), len(raw))
	rows, maxRecord := 0, 0
	err = s.ExportBackup(context.Background(), store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}, func(f store.BackupFrame) error {
		if f.Record != nil {
			rows++
			if len(f.Record.Data) > maxRecord {
				maxRecord = len(f.Record.Data)
			}
			if f.Record.Kind == "notification-private" {
				t.Error("legacy whole-state row retained after split writes")
			}
		}
		return nil
	})
	t.Logf("backup canonical/index records=%d maximum plaintext record bytes=%d", rows, maxRecord)
	t.Logf("default backup result: %v", err)
	if err != nil {
		t.Fatalf("accepted notifications must remain backup recoverable: %v", err)
	}
	// A legacy whole-state database of the same legitimate size must migrate
	// before a backup, without increasing limits or dropping dedupe evidence.
	legacyPath := filepath.Join(t.TempDir(), "legacy")
	legacy, err := store.Open(legacyPath, bytes.Repeat([]byte{22}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err = legacy.Put("notification-private", "state", st); err != nil {
		t.Fatal(err)
	}
	legacy.Close()
	legacy, err = store.Open(legacyPath, bytes.Repeat([]byte{22}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	restored, err := store.Open(filepath.Join(t.TempDir(), "restored"), bytes.Repeat([]byte{23}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	limits := store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}
	if err = restored.ImportBackup(context.Background(), limits, func(emit func(store.BackupFrame) error) error {
		return legacy.ExportBackup(context.Background(), limits, emit)
	}); err != nil {
		t.Fatal(err)
	}
	restoredState, err := restored.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	if len(restoredState.Events) != 5000 || len(restoredState.Deliveries) != 5000 || len(restoredState.Announcements) != 10 {
		t.Fatalf("backup lost accepted facts: %d events %d deliveries", len(restoredState.Events), len(restoredState.Deliveries))
	}
	if err = notifications.New(restored, nil).Evaluate(recipients, nil, now); err != nil {
		t.Fatal(err)
	}
	restoredState, err = restored.ReadNotifications()
	if err != nil || len(restoredState.Events) != 5000 {
		t.Fatalf("restored deduplication failed: %d %v", len(restoredState.Events), err)
	}

}
