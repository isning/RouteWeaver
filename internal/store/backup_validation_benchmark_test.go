package store_test

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

// This is a repeatable public-seam workload, not a wall-clock acceptance limit.
// Fixture creation is excluded; every iteration validates and exports every row.
func BenchmarkNotificationBackupValidation(b *testing.B) {
	for _, size := range []int{100, 1000} {
		b.Run(fmt.Sprintf("events-%d", size), func(b *testing.B) {
			s, err := store.Open(filepath.Join(b.TempDir(), "db"), bytes.Repeat([]byte{71}, 32))
			if err != nil {
				b.Fatal(err)
			}
			defer s.Close()
			n := notifications.New(s, nil)
			now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
			if err = n.SaveAnnouncement(notifications.Announcement{ID: "a", Title: "Synthetic", Body: strings.Repeat("A", 8000), Audience: "all", StartsAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour), Enabled: true}); err != nil {
				b.Fatal(err)
			}
			recipients := make([]notifications.Recipient, size)
			for i := range recipients {
				recipients[i] = notifications.Recipient{ID: fmt.Sprintf("u%d", i), Role: "user", Enabled: true}
			}
			if err = n.Evaluate(recipients, nil, now); err != nil {
				b.Fatal(err)
			}
			limits := store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				rows := 0
				if err := s.ExportBackup(context.Background(), limits, func(store.BackupFrame) error { rows++; return nil }); err != nil {
					b.Fatal(err)
				}
				b.ReportMetric(float64(rows), "rows/op")
			}
		})
	}
}
