package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestUsageProjectionRestoreCanonicalDifferentKey(t *testing.T) {
	for _, format := range []string{"snapshot-import", "snapshot-fresh", "stream-import", "stream-fresh"} {
		t.Run(format, func(t *testing.T) {
			source, _, _, scope, now := admissionFixture(t)
			if err := source.Put("ledger", "before-restore", projectionRecord("account", 19, 31, 1500000, now)); err != nil {
				t.Fatal(err)
			}
			if err := source.Put("unknown-future-kind", "preserved", map[string]string{"fact": "canonical"}); err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, source, scope, now, time.Time{}, time.Time{}, 0)
			ctx := context.Background()
			before, err := source.ExportSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "different-key.db")
			key := bytes.Repeat([]byte{93}, 32)
			limits := store.BackupLimits{MaxBytes: 16 << 20, MaxRows: 10000, MaxRecordBytes: 1 << 20}
			var restored *store.Store
			switch format {
			case "snapshot-fresh":
				err = store.RestoreFresh(ctx, target, key, before)
			case "stream-fresh":
				err = store.RestoreBackupFresh(ctx, target, key, source, limits)
			default:
				restored, err = store.Open(target, key)
				if err != nil {
					t.Fatal(err)
				}
				if format == "snapshot-import" {
					err = restored.ImportSnapshot(ctx, before)
				} else {
					err = restored.ImportBackup(ctx, limits, func(emit func(store.BackupFrame) error) error { return source.ExportBackup(ctx, limits, emit) })
				}
			}
			if err != nil {
				if restored != nil {
					restored.Close()
				}
				t.Fatal(err)
			}
			if restored == nil {
				restored, err = store.Open(target, key)
				if err != nil {
					t.Fatal(err)
				}
			}
			defer restored.Close()
			after, err := restored.ExportSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			a, _ := json.Marshal(before)
			b, _ := json.Marshal(after)
			if !bytes.Equal(a, b) {
				t.Fatal("canonical logical snapshot changed across different-key restore")
			}
			projectionAssertRemaining(t, restored, scope, now, time.Time{}, time.Time{}, 1)
			if err := restored.Put("ledger", "after-restore", projectionRecord("account", 5, 7, service.RateScale, now)); err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, restored, scope, now, time.Time{}, time.Time{}, 2)
		})
	}
}

// Deliberate faults in rebuildable schema are the only private-schema coupling.
// Assertions remain public: complete canonical usage must govern admission.
func TestUsageProjectionDerivedFaultRecovery(t *testing.T) {
	for _, fault := range []string{"missing-row", "corrupt-ciphertext", "missing-state", "unknown-version"} {
		t.Run(fault, func(t *testing.T) {
			s, path, _, scope, now := admissionFixture(t)
			if err := s.Put("ledger", "canonical", projectionRecord("account", 23, 11, service.RateScale, now)); err != nil {
				t.Fatal(err)
			}
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 0)
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			statement := `DELETE FROM usage_windows`
			if fault == "corrupt-ciphertext" {
				statement = `UPDATE usage_windows SET data=X'00'`
			}
			if fault == "missing-state" {
				statement = `DELETE FROM usage_projection_state WHERE id=1`
			}
			if fault == "unknown-version" {
				statement = `UPDATE usage_projection_state SET version=999 WHERE id=1`
			}
			result, err := db.Exec(statement)
			if err != nil {
				t.Fatal(err)
			}
			count, err := result.RowsAffected()
			if err != nil || count != 1 {
				t.Fatalf("fault injection did not affect exactly one warm window: %d %v", count, err)
			}
			projectionAssertRemaining(t, s, scope, now, time.Time{}, time.Time{}, 1)
		})
	}
}
