package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Logical Store restore only: this deliberately does not exercise password KDFs.
func TestLiveStateCanonicalRestoreDifferentKey(t *testing.T) {
	for _, format := range []string{"snapshot-fresh", "snapshot-import", "stream-fresh", "stream-import"} {
		t.Run(format, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			livePut(t, s, "admission-budgets", "canonical-reservation", liveBudget("account", "different-embedded", 40, 0, true, now.Add(time.Hour)))
			livePut(t, s, "entry-admission-leases", "canonical-lease", map[string]any{"id": "different-embedded", "binding": store.EntryAdmissionBinding{UserID: "account"}, "clientIp": "192.0.2.8", "expiresAt": now.Add(time.Hour)})
			in := admissionRequest("entry1", "192.0.2.1", "probe")
			liveExpect(t, s, scope, in, now, "ip-limit")
			ctx := context.Background()
			snapshot, err := s.ExportSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "restored.db")
			key := bytes.Repeat([]byte{94}, 32)
			limits := store.BackupLimits{MaxBytes: 16 << 20, MaxRows: 10000, MaxRecordBytes: 1 << 20}
			var restored *store.Store
			switch format {
			case "snapshot-fresh":
				err = store.RestoreFresh(ctx, path, key, snapshot)
			case "stream-fresh":
				err = store.RestoreBackupFresh(ctx, path, key, s, limits)
			default:
				restored, err = store.Open(path, key)
				if err != nil {
					t.Fatal(err)
				}
				defer restored.Close()
				if format == "snapshot-import" {
					err = restored.ImportSnapshot(ctx, snapshot)
				} else {
					err = restored.ImportBackup(ctx, limits, func(emit func(store.BackupFrame) error) error { return s.ExportBackup(ctx, limits, emit) })
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if restored == nil {
				restored, err = store.Open(path, key)
				if err != nil {
					t.Fatal(err)
				}
				defer restored.Close()
			}
			after, err := restored.ExportSnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			a, _ := json.Marshal(snapshot)
			b, _ := json.Marshal(after)
			if !bytes.Equal(a, b) {
				t.Fatal("canonical history changed on logical restore")
			}
			liveExpect(t, restored, scope, in, now, "ip-limit")
			if err = restored.Remove("entry-admission-leases", "canonical-lease"); err != nil {
				t.Fatal(err)
			}
			v := liveExpect(t, restored, scope, in, now, "")
			if v.ByteBudget == nil || *v.ByteBudget != 60 {
				t.Fatalf("restored reservation vanished: %+v", v)
			}
			in.AdmittedBytes = 10
			in.Final = true
			liveExpect(t, restored, scope, in, now.Add(time.Second), "presence-closed")
			v = liveExpect(t, restored, scope, admissionRequest("entry1", "192.0.2.1", "next"), now.Add(2*time.Second), "")
			if v.ByteBudget == nil || *v.ByteBudget != 50 {
				t.Fatalf("post-restore settlement lost: %+v", v)
			}
		})
	}
}
