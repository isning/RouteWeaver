package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestLegacyNotificationsMigrateLosslesslyAndBackupRestores(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{31}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	old := notifications.DefaultState()
	old.Secrets.SMTPPassword = "synthetic-preserved-secret"
	old.Events["event"] = notifications.Event{EventID: "event", RecipientID: "alice", Kind: "quota", Title: "Keep history", Body: "Original payload", CreatedAt: now}
	old.Deliveries["event/email"] = notifications.Delivery{EventID: "event", Channel: "email", Status: "sending", Attempts: 2, LeaseToken: "lease", LeaseUntil: now.Add(time.Minute), SettingsRevision: 3}
	old.Reads["alice/event"] = now
	if err = s.Put("notification-private", "state", old); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, old) {
		t.Fatalf("migration changed accepted notification facts: %+v", got)
	}
	frames := []store.BackupFrame{}
	if err = s.ExportBackup(context.Background(), store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}, func(f store.BackupFrame) error {
		if f.Record != nil {
			copy := *f.Record
			copy.Data = bytes.Clone(copy.Data)
			f.Record = &copy
		}
		frames = append(frames, f)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Reopen is idempotent and retains leases, settings, read receipts and event IDs.
	other, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	got, err = other.ReadNotifications()
	if err != nil || !reflect.DeepEqual(got, old) {
		t.Fatalf("second handle changed history: %v", err)
	}
	restored, err := store.Open(filepath.Join(t.TempDir(), "restored"), bytes.Repeat([]byte{32}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.ImportBackup(context.Background(), store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}, func(emit func(store.BackupFrame) error) error {
		for _, frame := range frames {
			if e := emit(frame); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got, err = restored.ReadNotifications()
	if err != nil || !reflect.DeepEqual(got, old) {
		t.Fatalf("backup round trip lost notifications: %v", err)
	}
}

func TestLegacyNotificationMigrationFailurePreservesOriginal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{41}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	old := notifications.DefaultState()
	old.Events["event"] = notifications.Event{EventID: "event", RecipientID: "alice", Title: "Original"}
	if err = s.Put("notification-private", "state", old); err != nil {
		t.Fatal(err)
	}
	s.Close()
	fault, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`CREATE TRIGGER fail_notification_migration BEFORE INSERT ON records WHEN NEW.kind='notification-events' BEGIN SELECT RAISE(ABORT,'synthetic migration fault'); END`); err != nil {
		t.Fatal(err)
	}
	if opened, e := store.Open(path, key); e == nil {
		opened.Close()
		t.Fatal("partial migration accepted")
	}
	var count int
	if err = fault.QueryRow(`SELECT count(*) FROM records WHERE kind LIKE 'notification-%' AND kind!='notification-private'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial notification rows committed: %d %v", count, err)
	}
	if _, err = fault.Exec(`DROP TRIGGER fail_notification_migration`); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.ReadNotifications()
	if err != nil || !reflect.DeepEqual(got, old) {
		t.Fatalf("failed migration lost original state: %v", err)
	}
}
