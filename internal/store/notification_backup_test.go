package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestNotificationBackupRejectsIncompleteIndexesWithoutReplacingTarget(t *testing.T) {
	source, err := store.Open(filepath.Join(t.TempDir(), "source"), bytes.Repeat([]byte{61}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if _, err = notifications.New(source, nil).Test("in-app", notifications.Recipient{ID: "admin", Role: "admin", Enabled: true}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	target, err := store.Open(filepath.Join(t.TempDir(), "target"), bytes.Repeat([]byte{62}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	if err = target.Put("test-marker", "keep", map[string]string{"value": "unchanged"}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"notification-pending", "notification-inbox/", "notification-history"} {
		broken := snapshot
		broken.Records = append([]store.BackupRecord{}, snapshot.Records...)
		found := false
		for i, r := range broken.Records {
			if strings.HasPrefix(r.Kind, kind) {
				broken.Records = append(broken.Records[:i], broken.Records[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("fixture lacks %s", kind)
		}
		if err = target.ImportSnapshot(context.Background(), broken); err == nil {
			t.Fatalf("incomplete %s backup accepted", kind)
		}
		var marker map[string]string
		if err = target.Get("test-marker", "keep", &marker); err != nil || marker["value"] != "unchanged" {
			t.Fatalf("failed restore changed target: %v", err)
		}
	}
	mixed := snapshot
	mixed.Records = append([]store.BackupRecord{}, snapshot.Records...)
	legacy, _ := json.Marshal(notifications.DefaultState())
	mixed.Records = append(mixed.Records, store.BackupRecord{Kind: "notification-private", ID: "state", Data: legacy})
	if err = target.ImportSnapshot(context.Background(), mixed); err == nil {
		t.Fatal("mixed notification representations accepted")
	}
	var marker map[string]string
	if err = target.Get("test-marker", "keep", &marker); err != nil || marker["value"] != "unchanged" {
		t.Fatal("mixed-state restore replaced healthy target")
	}

	legacyOnly, e := target.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	legacyOnly.Records = append(legacyOnly.Records, store.BackupRecord{Kind: "notification-private", ID: "state", Data: json.RawMessage(`{"unexpectedLegacyField":"synthetic-private-value"}`)})
	if err = target.ImportSnapshot(context.Background(), legacyOnly); err == nil || strings.Contains(err.Error(), "synthetic-private-value") {
		t.Fatalf("unsupported legacy backup not safely refused: %v", err)
	}
	if err = target.Get("test-marker", "keep", &marker); err != nil || marker["value"] != "unchanged" {
		t.Fatal("unsupported legacy restore replaced healthy target")
	}

}
