package store

import (
	"bytes"
	"database/sql"
	"path/filepath"
	"routeweaver/internal/notifications"
	"testing"
)

func TestModernNotificationReadDoesNotReserveWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, err := Open(path, bytes.Repeat([]byte{81}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.UpdateNotifications(func(st *notifications.State) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`PRAGMA busy_timeout=1`); err != nil {
		t.Fatal(err)
	}
	other, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	writer, err := other.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err = writer.Exec(`UPDATE counters SET value=value`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadNotificationsScope(notifications.Scope{}); err != nil {
		t.Fatalf("modern notification read attempted to reserve SQLite writer: %v", err)
	}
}
