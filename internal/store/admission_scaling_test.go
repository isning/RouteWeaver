package store_test

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

// Opt-in characterization, never a shared-host millisecond SLA. Only ledger
// history grows here; unchanged lease/budget/policy scans remain separate costs.
func TestAdmissionHistoryScalingCharacterization(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MEASURE_ADMISSION_HISTORY") != "1" {
		t.Skip("explicit workload characterization not requested")
	}
	for _, owner := range []string{"unrelated-account", "account"} {
		for _, count := range []int{0, 1000, 10000} {
			t.Run(fmt.Sprintf("%s/%d", owner, count), func(t *testing.T) {
				s, path, key, scope, now := admissionFixture(t)
				finiteAdmissionPlan(t, s, 1<<24)
				for offset := 0; offset < count; offset += 1000 {
					writes := make([]store.RecordWrite, 0, 1000)
					for i := offset; i < count && i < offset+1000; i++ {
						at := now.Add(-24 * time.Hour)
						if i%2 == 0 {
							at = now.Add(-365 * 24 * time.Hour)
						} // No-reset includes old lifetime facts too.
						record := store.MeterRecord{MeterBatch: store.MeterBatch{UserID: owner, RouteID: "route", MeterID: "history", Epoch: "old", Sequence: uint64(i + 1), RawBytes: 1, ObservedAt: at}, RateID: "default-1x", RateMicros: service.RateScale, RecordedAt: at}
						writes = append(writes, store.RecordWrite{Kind: "ledger", ID: fmt.Sprintf("history-%d", i), Value: record})
					}
					if err := s.CompareAndPutRecords(nil, writes); err != nil {
						t.Fatal(err)
					}
				}
				request := admissionRequest("entry1", "192.0.2.1", "measurement")
				measure := func(s *store.Store, i int) time.Duration {
					start := time.Now()
					reply, err := s.AcquireAdmission(scope, request, now.Add(time.Duration(i)*time.Millisecond))
					elapsed := time.Since(start)
					if err != nil || !reply.Allowed {
						t.Fatalf("renewal failed: %+v %v", reply, err)
					}
					return elapsed
				}
				cold := measure(s, 0)
				samples, settlements := []time.Duration{}, []time.Duration{}
				for i := 1; i <= 7; i++ {
					samples = append(samples, measure(s, i))
				}
				for i := 8; i <= 14; i++ {
					request.AdmittedBytes += 16
					settlements = append(settlements, measure(s, i))
				}
				sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
				sort.Slice(settlements, func(i, j int) bool { return settlements[i] < settlements[j] })
				size := func(name string) int64 {
					info, err := os.Stat(name)
					if err != nil {
						return 0
					}
					return info.Size()
				}
				dbBytes, walBytes := size(path), size(path+"-wal")
				start := time.Now()
				err := s.ExportBackup(context.Background(), store.BackupLimits{MaxBytes: 64 << 20, MaxRows: 20000, MaxRecordBytes: 1 << 20}, func(store.BackupFrame) error { return nil })
				backup := time.Since(start)
				if err != nil {
					t.Fatal(err)
				}
				start = time.Now()
				other, err := store.Open(path, key)
				reopen := time.Since(start)
				if err != nil {
					t.Fatal(err)
				}
				defer other.Close()
				reopenCold := measure(other, 15)
				t.Logf("owner=%s rows=%d cold=%s warm_median=%s warm_max=%s settlement_median=%s settlement_max=%s reopen=%s reopen_cold=%s backup=%s db_bytes=%d wal_bytes=%d samples=7", owner, count, cold, samples[3], samples[6], settlements[3], settlements[6], reopen, reopenCold, backup, dbBytes, walBytes)
			})
		}
	}
}
