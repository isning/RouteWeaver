package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestBackupRelationshipLookupReuseRetainsValidationAndFreshness(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source"), bytes.Repeat([]byte{72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n := notifications.New(s, nil)
	for i, id := range []string{"a", "much-longer-owner-b"} {
		if _, err := n.Test("in-app", notifications.Recipient{ID: id, Role: "admin", Enabled: true}, time.Date(2026, 11, 1, 0, 0, i, 0, time.UTC)); err != nil {
			t.Fatal(err)
		}
	}
	limits := store.BackupLimits{MaxBytes: 16 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}
	export := func(ctx context.Context) ([]byte, error) {
		var output bytes.Buffer
		enc := json.NewEncoder(&output)
		err := s.ExportBackup(ctx, limits, func(f store.BackupFrame) error { return enc.Encode(f) })
		return output.Bytes(), err
	}
	want, err := export(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var records []store.BackupRecord
	if err = s.ExportBackup(context.Background(), limits, func(f store.BackupFrame) error {
		if f.Record != nil {
			r := *f.Record
			r.Data = append(json.RawMessage(nil), r.Data...)
			records = append(records, r)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"notification-config", "notification-history", "notification-pending"} {
		t.Run(kind, func(t *testing.T) {
			var original *store.BackupRecord
			for i := range records {
				if records[i].Kind == kind {
					original = &records[i]
					break
				}
			}
			if original == nil {
				t.Fatalf("fixture missing %s", kind)
			}
			// Reuse on a new snapshot must see changed data, not an earlier lookup.
			if err := s.Put(original.Kind, original.ID, json.RawMessage(`"wrong-reference"`)); err != nil {
				t.Fatal(err)
			}
			got, err := export(context.Background())
			if err == nil || len(got) != 0 {
				t.Fatalf("invalid relationship emitted a successful/partial archive: %v bytes=%d", err, len(got))
			}
			if err := s.Put(original.Kind, original.ID, original.Data); err != nil {
				t.Fatal(err)
			}
			got, err = export(context.Background())
			if err != nil || !bytes.Equal(want, got) {
				t.Fatalf("restored relationship or repeated lookup changed export: %v", err)
			}
		})
	}
	target, err := store.Open(filepath.Join(t.TempDir(), "target"), bytes.Repeat([]byte{73}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	if err = target.ImportBackup(context.Background(), limits, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackup(context.Background(), limits, func(f store.BackupFrame) error {
			if f.Record != nil && f.Record.Kind == "notification-config" {
				return nil
			}
			return emit(f)
		})
	}); err == nil {
		t.Fatal("missing configuration accepted during streamed restore")
	}
	// The failed validation must leave a fresh target usable for an exact retry.
	if err = target.ImportBackup(context.Background(), limits, func(emit func(store.BackupFrame) error) error {
		return s.ExportBackup(context.Background(), limits, emit)
	}); err != nil {
		t.Fatal("valid restore after missing-config rejection:", err)
	}
	var restored bytes.Buffer
	if err = target.ExportBackup(context.Background(), limits, func(f store.BackupFrame) error {
		return json.NewEncoder(&restored).Encode(f)
	}); err != nil || !bytes.Equal(want, restored.Bytes()) {
		t.Fatalf("missing-config rollback or retry changed canonical backup: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, err := export(ctx); !errors.Is(err, context.Canceled) || len(got) != 0 {
		t.Fatalf("cancellation: %v bytes=%d", err, len(got))
	}
	if got, err := export(context.Background()); err != nil || !bytes.Equal(want, got) {
		t.Fatalf("retry after cancellation: %v", err)
	}
	// A memoized existing configuration must still reject mixed representations.
	if err := s.Put("notification-private", "state", notifications.DefaultState()); err != nil {
		t.Fatal(err)
	}
	if got, err := export(context.Background()); err == nil || len(got) != 0 {
		t.Fatalf("mixed notification representations accepted: %v bytes=%d", err, len(got))
	}

}
