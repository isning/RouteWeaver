//go:build linux || darwin

package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
)

func migrationFileDigests(t *testing.T, path string) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	for _, name := range []string{path, path + "-wal"} {
		f, err := os.Open(name)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.New()
		_, err = io.Copy(hash, f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		var digest [32]byte
		copy(digest[:], hash.Sum(nil))
		out[name] = digest
	}
	return out
}
func TestOfflineNotificationMigrationLargeLegacyOptIn(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_RUN_LARGE_NOTIFICATION_MIGRATION") != "1" {
		t.Skip("explicit opt-in: >64 MiB legacy migration, run non-race with reviewed memory budget")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	path := filepath.Join(t.TempDir(), "large-source.db")
	output := filepath.Join(t.TempDir(), "large-output.db")
	key := bytes.Repeat([]byte{83}, 32)
	source, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	expiry := now.Add(24 * time.Hour)
	state := notifications.DefaultState()
	body := strings.Repeat("b", 8000)
	state.Secrets.SMTPPassword = "synthetic-large-migration-secret"
	state.Announcements["notice"] = notifications.Announcement{ID: "notice", Title: "Retained announcement", Body: body, Audience: "all", Enabled: true, StartsAt: now, ExpiresAt: expiry}
	const events = 8500
	for i := 0; i < events; i++ {
		id := fmt.Sprintf("%064x", i)
		owner := fmt.Sprintf("user-%d", i)
		state.Events[id] = notifications.Event{EventID: id, Kind: "announcement", RecipientID: owner, Title: "Retained announcement", Body: body, CreatedAt: now, ExpiresAt: &expiry, AnnouncementID: "notice"}
		state.Deliveries[id+"/in-app"] = notifications.Delivery{EventID: id, Channel: "in-app", Status: "available", CreatedAt: now}
	}
	first, last := fmt.Sprintf("%064x", 0), fmt.Sprintf("%064x", events-1)
	state.Reads["user-0/"+first] = now
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("legacy plaintext=%d bytes, events=%d, per-event body=%d bytes, reviewed offline budget=%d", len(encoded), events, len(body), 80<<20)
	if len(encoded) <= store.MaxLegacyNotificationBytes || len(encoded) > 80<<20 {
		t.Fatal("fixture outside intended >64MiB and <=80MiB range")
	}
	if err = source.Put("notification-private", "state", json.RawMessage(encoded)); err != nil {
		t.Fatal(err)
	}
	encoded = nil
	state = notifications.State{}
	runtime.GC()
	before := migrationFileDigests(t, path)
	if _, ok := before[path+"-wal"]; !ok {
		t.Fatal("large fixture must retain WAL")
	}
	if opened, e := store.Open(path, key); e == nil {
		opened.Close()
		t.Fatal("ordinary Open accepted oversized legacy state")
	} else if !errors.Is(e, store.ErrLegacyNotificationLimit) {
		t.Fatalf("wrong refusal: %v", e)
	}
	if after := migrationFileDigests(t, path); !reflectMigrationDigests(before, after) {
		t.Fatal("ordinary refusal changed source")
	}
	if err = store.MigrateNotificationsFresh(ctx, path, output, key, 80<<20); err != nil {
		t.Fatal(err)
	}
	if after := migrationFileDigests(t, path); !reflectMigrationDigests(before, after) {
		t.Fatal("offline migration changed source database/WAL")
	}
	migrated, err := store.Open(output, key)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	sample, err := migrated.ReadNotificationsScope(notifications.Scope{EventIDs: []string{first, last}, ReceiptOwner: "user-0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(sample.Events) != 2 || sample.Events[first].Body != body || sample.Events[last].Body != body || !sample.Reads["user-0/"+first].Equal(now) || sample.Secrets.SMTPPassword != "synthetic-large-migration-secret" {
		t.Fatal("sample payload/receipt/settings changed")
	}
	db, err := sql.Open("sqlite", output)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM records WHERE kind='notification-events'`).Scan(&count); err != nil || count != events {
		t.Fatalf("event history count=%d err=%v", count, err)
	}
	var records int
	if err = migrated.ExportBackup(ctx, store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}, func(frame store.BackupFrame) error {
		if frame.Record != nil {
			records++
			if frame.Record.Kind == "notification-private" {
				return errors.New("legacy row exported")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("default32MiB per-record backup validated; records=%d", records)
	targetBefore := migrationFileDigests(t, output)
	if err = store.MigrateNotificationsFresh(ctx, path, output, key, 80<<20); err == nil {
		t.Fatal("existing output overwritten")
	}
	if after := migrationFileDigests(t, output); !reflectMigrationDigests(targetBefore, after) {
		t.Fatal("refused overwrite changed output")
	}
}
func reflectMigrationDigests(a, b map[string][32]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for name, digest := range a {
		other, ok := b[name]
		if !ok || other != digest {
			return false
		}
	}
	return true
}
