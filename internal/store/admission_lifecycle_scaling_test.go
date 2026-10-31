package store_test

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"routeweaver/internal/store"
)

// Characterizes retained CLOSED history separately from ledger growth. Seeds
// exact records produced by public admission/finalization, not invented schemas.
func TestAdmissionClosedHistoryScalingCharacterization(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MEASURE_ADMISSION_HISTORY") != "1" {
		t.Skip("explicit workload characterization not requested")
	}
	for _, count := range []int{0, 1000, 10000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
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
			for offset := 0; offset < count; offset += 500 {
				writes := []store.RecordWrite{}
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
						writes = append(writes, store.RecordWrite{Kind: kind, ID: id, Value: record})
					}
				}
				if err := s.CompareAndPutRecords(nil, writes); err != nil {
					t.Fatal(err)
				}
			}
			now = now.Add(time.Second)
			live := admissionRequest("entry1", "192.0.2.1", "live")
			if out, err := s.AcquireAdmission(scope, live, now); err != nil || !out.Allowed {
				t.Fatalf("warm: %+v %v", out, err)
			}
			for _, mode := range []string{"renewal", "new-stream"} {
				durations := []time.Duration{}
				for i := 0; i < 6; i++ {
					input := live
					if mode == "new-stream" {
						input.PresenceID = fmt.Sprintf("new-%d", i)
					}
					at := now.Add(time.Duration(i+1) * 50 * time.Millisecond)
					if mode == "new-stream" {
						at = at.Add(time.Second)
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
				t.Logf("closed lease+budget pairs=%d mode=%s median=%s max=%s", count, mode, durations[len(durations)/2], durations[len(durations)-1])
			}
		})
	}
}
