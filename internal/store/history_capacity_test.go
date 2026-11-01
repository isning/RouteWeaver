package store

import (
	"context"
	"errors"
	"testing"
)

func TestHistoryCapacityInventoryBoundsCountsAndPreservesCanonicalData(t *testing.T) {
	s := projectionTestStore(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.Put("meter-inbox", id, map[string]string{"fact": "retained"}); err != nil {
			t.Fatal(err)
		}
	}
	limits := BackupLimits{MaxRows: 2, MaxBytes: 1 << 20, MaxRecordBytes: 1 << 20}
	got, err := s.HistoryCapacityInventory(context.Background(), limits)
	if err != nil {
		t.Fatal(err)
	}
	if got.BackupRows.Count != 3 || !got.BackupRows.AtLeast || !got.BackupRows.Exceeded || !got.BackupRows.Warning {
		t.Fatalf("bounded cap: %+v", got)
	}
	if got.ArchiveBytes != nil || got.DatabaseFileBytes == nil || got.NotificationLedgerRows.Count != 0 {
		t.Fatalf("unknown vs zero: %+v", got)
	}
	rows, err := s.List("meter-inbox")
	if err != nil || len(rows) != 3 {
		t.Fatalf("inventory mutated history: %d %v", len(rows), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.HistoryCapacityInventory(ctx, limits); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	limits.MaxRows = 2000001
	if _, err = s.HistoryCapacityInventory(context.Background(), limits); !errors.Is(err, ErrInvalidCapacityLimits) {
		t.Fatalf("raised cap accepted: %v", err)
	}
}
func TestHistoryCapacityWarningStartsAtEightyPercent(t *testing.T) {
	for _, tt := range []struct {
		n                 int64
		warning, exceeded bool
	}{{79, false, false}, {80, true, false}, {100, true, false}, {101, true, true}} {
		got := capacityCount(tt.n, 100, false)
		if got.Warning != tt.warning || got.Exceeded != tt.exceeded {
			t.Fatalf("count %d: %+v", tt.n, got)
		}
	}
	if historyAvailableBytes("/nonexistent-synthetic-routeweaver-capacity-path") != nil {
		t.Fatal("missing filesystem reported as known zero")
	}
}

func TestHistoryCapacityWarnsForBytesBeforeRowLimit(t *testing.T) {
	s := projectionTestStore(t)
	if err := s.Put("meter-inbox", "large", map[string]string{"value": string(make([]byte, 100))}); err != nil {
		t.Fatal(err)
	}
	limits := BackupLimits{MaxRows: 1000, MaxBytes: 256, MaxRecordBytes: 128}
	got, err := s.HistoryCapacityInventory(context.Background(), limits)
	if err != nil {
		t.Fatal(err)
	}
	if got.BackupRows.Warning || !got.BackupRecordPlaintextBytes.Warning || !got.BackupLargestRecordBytes.Exceeded || got.ArchiveBytes != nil {
		t.Fatalf("byte headroom hidden by small row count: %+v", got)
	}
}

func TestHistoryCapacityRefusesUnknownSchemaInsteadOfOmittingIt(t *testing.T) {
	s := projectionTestStore(t)
	if _, err := s.db.Exec(`CREATE TABLE unrecognized_history(id TEXT PRIMARY KEY,data BLOB)`); err != nil {
		t.Fatal(err)
	}
	got, err := s.HistoryCapacityInventory(context.Background(), BackupLimits{MaxRows: 100, MaxBytes: 1 << 20, MaxRecordBytes: 1 << 20})
	if err == nil || !got.CheckedAt.IsZero() {
		t.Fatalf("unsupported schema returned a usable report: %+v %v", got, err)
	}
}
