package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestProviderSuspensionRequiresMonotonicPortableDowngradeFence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{47}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	if err = s.Put("hosts", "host", domain.Host{ID: "host", Name: "Host"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("core-instances", "core", domain.CoreInstance{ID: "core", HostID: "host", AdapterID: "routeweaver/managed-xray"}); err != nil {
		t.Fatal(err)
	}
	cfg := suspensionConfig(time.Now().UTC())
	cfg.Provider.ExhaustionAction = "advisory"
	state, err := s.ConfigureNodeObservations("host", cfg)
	if err != nil {
		t.Fatal(err)
	}
	old, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(old.Migrations) != 2 {
		t.Fatal("advisory-only data needlessly fenced", old.Migrations)
	}
	invalid := state.Config
	invalidProvider := *invalid.Provider
	invalid.Provider = &invalidProvider
	invalid.Provider.ExhaustionAction = "suspend-managed"
	invalid.Provider.NotificationSource = ""
	if _, err = s.ConfigureNodeObservations("host", invalid); err == nil {
		t.Fatal("invalid source accepted")
	}
	unchanged, err := s.ExportSnapshot(context.Background())
	if err != nil || len(unchanged.Migrations) != 2 {
		t.Fatal("failed configuration persisted migration fence", err)
	}
	state.Config.Provider.ExhaustionAction = "suspend-managed"
	if _, err = s.ConfigureNodeObservations("host", state.Config); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Migrations) != 3 || snapshot.Migrations[2].Version != 3 {
		t.Fatal("enforcing provider policy lacks downgrade fence", snapshot.Migrations)
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	if err = store.RestoreFresh(context.Background(), target, key, snapshot); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	restored.Close()
	snapshot.Migrations = snapshot.Migrations[:2]
	if store.ValidateSnapshot(snapshot) == nil {
		t.Fatal("portable policy allowed without compatibility fence")
	}
	fresh, err := store.Open(filepath.Join(t.TempDir(), "rejected.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if err = fresh.ImportSnapshot(context.Background(), snapshot); err == nil {
		t.Fatal("snapshot import accepted unmarked enforcing policy")
	}
	err = fresh.ImportBackup(context.Background(), store.BackupLimits{MaxRows: 2000000, MaxBytes: 1 << 30, MaxRecordBytes: 128 << 20}, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackup(context.Background(), store.BackupLimits{MaxRows: 2000000, MaxBytes: 1 << 30, MaxRecordBytes: 128 << 20}, func(frame store.BackupFrame) error {
			if frame.Migration != nil && frame.Migration.Version == 3 {
				return nil
			}
			return emit(frame)
		})
	})
	if err == nil {
		t.Fatal("stream import accepted unmarked enforcing policy")
	}
	if _, err = fresh.NodeObservations("host"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("failed restore mutated target", err)
	}

	state, err = s.NodeObservations("host")
	if err != nil {
		t.Fatal(err)
	}
	state.Config.Provider.ExhaustionAction = "advisory"
	if _, err = s.ConfigureNodeObservations("host", state.Config); err != nil {
		t.Fatal(err)
	}
	after, err := s.ExportSnapshot(context.Background())
	if err != nil || len(after.Migrations) != 3 {
		t.Fatal("disable silently removed downgrade fence", err)
	}
	s.Close()
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
}

func TestProviderSuspensionOpenRejectsUnmarkedEnforcingRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unmarked.db")
	key := bytes.Repeat([]byte{48}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Put("node-observability", "host", map[string]any{"config": suspensionConfig(time.Now().UTC())}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var before, after []byte
	if err = db.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(path, key)
	if err == nil {
		reopened.Close()
		t.Fatal("unmarked enforcing policy opened")
	}
	if !errors.Is(err, store.ErrUnsupportedSchema) {
		t.Fatal("wrong rejection", err)
	}
	if err = db.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("rejected policy changed encrypted metadata")
	}
}
