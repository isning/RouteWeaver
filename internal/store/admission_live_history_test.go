package store_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"routeweaver/internal/store"
)

// Equivalent canonical histories seeded with logical snapshot import. Unlike
// the original tracked-write benchmark, setup starts with absent derived state;
// this is not an identical end-to-end workload. Cold reconstruction is timed.
func TestAdmissionSnapshotSeededHistoryCharacterization(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MEASURE_ADMISSION_SNAPSHOT_HISTORY") != "1" {
		t.Skip("explicit workload characterization not requested")
	}
	for _, count := range []int{0, 1000, 10000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s, _, key, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 1<<24)
			seed := admissionRequest("entry1", "192.0.2.1", "seed")
			if out, err := s.AcquireAdmission(scope, seed, now); err != nil || !out.Allowed {
				t.Fatalf("seed: %+v %v", out, err)
			}
			seed.Final = true
			if _, err := s.AcquireAdmission(scope, seed, now.Add(time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			histories := map[string]json.RawMessage{}
			for _, kind := range []string{"admission-budgets", "entry-admission-leases"} {
				rows, err := s.List(kind)
				if err != nil || len(rows) != 1 {
					t.Fatalf("seed history %s: %d %v", kind, len(rows), err)
				}
				histories[kind] = rows[0]
			}
			snapshot, err := s.ExportSnapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			setupStart := time.Now()
			for offset := 0; offset < count; offset += 500 {
				writes := []store.BackupRecord{}
				for i := offset; i < count && i < offset+500; i++ {
					id := fmt.Sprintf("closed-history-%d", i)
					for kind, raw := range histories {
						var record map[string]any
						if err := json.Unmarshal(raw, &record); err != nil {
							t.Fatal(err)
						}
						if kind == "admission-budgets" {
							record["leaseId"] = id
						} else {
							record["id"] = id
							record["presenceId"] = id
						}
						data, err := json.Marshal(record)
						if err != nil {
							t.Fatal(err)
						}
						writes = append(writes, store.BackupRecord{Kind: kind, ID: id, Data: data})
					}
				}
				snapshot.Records = append(snapshot.Records, writes...)
			}
			sort.Slice(snapshot.Records, func(i, j int) bool {
				if snapshot.Records[i].Kind != snapshot.Records[j].Kind {
					return snapshot.Records[i].Kind < snapshot.Records[j].Kind
				}
				return snapshot.Records[i].ID < snapshot.Records[j].ID
			})
			restored, err := store.Open(filepath.Join(t.TempDir(), "snapshot-seeded.db"), key)
			if err != nil {
				t.Fatal(err)
			}
			defer restored.Close()
			s = restored
			if err := s.ImportSnapshot(context.Background(), snapshot); err != nil {
				t.Fatal(err)
			}
			t.Logf("snapshot-seeded pairs=%d setup=%s", count, time.Since(setupStart))
			now = now.Add(time.Second)
			live := admissionRequest("entry1", "192.0.2.1", "live")
			coldStart := time.Now()
			if out, err := s.AcquireAdmission(scope, live, now); err != nil || !out.Allowed {
				t.Fatalf("warm: %+v %v", out, err)
			}
			t.Logf("snapshot-seeded pairs=%d first cold admission=%s", count, time.Since(coldStart))
			for _, mode := range []string{"renewal", "settlement-renewal", "new-stream"} {
				durations := []time.Duration{}
				for i := 0; i < 6; i++ {
					input := live
					if mode == "settlement-renewal" {
						input.AdmittedBytes = uint64((i + 1) * 1000)
					}
					if mode == "new-stream" {
						input.PresenceID = fmt.Sprintf("new-%d", i)
					}
					at := now.Add(time.Duration(i+1) * 50 * time.Millisecond)
					if mode == "settlement-renewal" {
						at = at.Add(time.Second)
					}
					if mode == "new-stream" {
						at = at.Add(2 * time.Second)
					}
					start := time.Now()
					out, err := s.AcquireAdmission(scope, input, at)
					elapsed := time.Since(start)
					if err != nil || !out.Allowed {
						t.Fatalf("%s: %+v %v", mode, out, err)
					}
					durations = append(durations, elapsed)
					if mode == "new-stream" {
						input.Final = true
						if _, err = s.AcquireAdmission(scope, input, at.Add(time.Millisecond)); err != nil {
							t.Fatal(err)
						}
					}
				}
				sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
				t.Logf("snapshot-seeded closed lease+budget pairs=%d mode=%s median=%s max=%s", count, mode, durations[len(durations)/2], durations[len(durations)-1])
			}
		})
	}
}
