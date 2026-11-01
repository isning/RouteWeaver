package store

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func TestReopenDoesNotTrustRestoredTriggerAfterOfflineBypass(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{35}, 32)
	s, err := Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	if got := projectionTestRead(t, s, "u"); got.RawBytes != 0 {
		t.Fatal(got)
	}
	var original string
	if err = s.db.QueryRow(`SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='usage_ledger_insert'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`DROP TRIGGER usage_ledger_insert; CREATE TRIGGER usage_ledger_insert AFTER INSERT ON records BEGIN SELECT 1; END`); err != nil {
		t.Fatal(err)
	}
	raw, err := s.seal("ledger", "hidden", MeterRecord{MeterBatch: MeterBatch{UserID: "u", RawBytes: 19}, RateMicros: service.RateScale})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','hidden',?)`, raw); err != nil {
		t.Fatal(err)
	}
	// Restore the exact definition, leaving generation falsely clean. Startup
	// must distrust derived state even though all trigger names/text now match.
	if _, err = s.db.Exec(`DROP TRIGGER usage_ledger_insert;` + original); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if got := projectionTestRead(t, s, "u"); got.RawBytes != 19 {
		t.Fatalf("reopen trusted replaced trigger: %+v", got)
	}
}

func TestHistoricalUsageContextStreamsCanonicalWindowAndCancels(t *testing.T) {
	s := projectionTestStore(t)
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	records := []MeterRecord{
		{MeterBatch: MeterBatch{UserID: "u", RawBytes: 1, ProviderBytes: 3, ObservedAt: now}, RateMicros: 500000},
		{MeterBatch: MeterBatch{UserID: "u", RawBytes: 1, ProviderBytes: 4, ObservedAt: now.Add(time.Second)}, RateMicros: 500000},
		{MeterBatch: MeterBatch{UserID: "u", RawBytes: 99, ObservedAt: now.Add(2 * time.Second)}, RateMicros: service.RateScale},
		{MeterBatch: MeterBatch{UserID: "other", RawBytes: 900, ObservedAt: now}, RateMicros: service.RateScale},
	}
	for i, r := range records {
		if err := s.Put("ledger", string(rune('a'+i)), r); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.UsageContext(context.Background(), "u", now, now.Add(2*time.Second))
	if err != nil || got != (service.UsageTotals{RawBytes: 2, ProviderBytes: 7, WeightedBytes: 1}) {
		t.Fatalf("window/rounding: %+v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err = s.UsageContext(ctx, "u", time.Time{}, time.Time{})
	if !errors.Is(err, context.Canceled) || got != (service.UsageTotals{}) {
		t.Fatalf("cancel returned partial totals: %+v %v", got, err)
	}
	if err = s.Put("ledger", "z-bad", map[string]string{"rawBytes": "bad"}); err != nil {
		t.Fatal(err)
	}
	got, err = s.Usage("u", time.Time{}, time.Time{})
	if err == nil || got != (service.UsageTotals{}) {
		t.Fatalf("malformed canonical history hidden: %+v %v", got, err)
	}
}

func TestDirtyReopenReconstructsCompleteCanonicalUsage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{36}, 32)
	s, err := Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	projectionTestRead(t, s, "u")
	raw, err := s.seal("ledger", "bypass", MeterRecord{MeterBatch: MeterBatch{UserID: "u", RawBytes: 23}, RateMicros: service.RateScale})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','bypass',?)`, raw); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if got := projectionTestRead(t, s, "u"); got.RawBytes != 23 {
		t.Fatalf("dirty reopen retained stale totals: %+v", got)
	}
}
