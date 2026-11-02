package store_test

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestMeterRecordsOverQuotaAndKeepsHistoricalRate(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.PutUser(domain.User{ID: "u", Name: "User", QuotaBytes: 1, Enabled: false})
	now := time.Now().UTC()
	if e = s.SetRate(service.Rate{ID: "v1", RouteID: "r", Micros: 2000000, EffectiveAt: now.Add(-time.Hour)}); e != nil {
		t.Fatal(e)
	}
	m := store.MeterBatch{UserID: "u", RouteID: "r", MeterID: "entry", Epoch: "boot1", Sequence: 1, RawBytes: 10, ProviderBytes: 70, ObservedAt: now}
	if e = s.RecordMeter(m); e != nil {
		t.Fatal(e)
	}
	if e = s.RecordMeter(m); e != nil {
		t.Fatal(e)
	}
	m.RawBytes = 20
	if e = s.RecordMeter(m); e == nil {
		t.Fatal("conflicting replay accepted")
	}
	if e = s.SetRate(service.Rate{ID: "v2", RouteID: "r", Micros: 1000000, EffectiveAt: now.Add(time.Second)}); e != nil {
		t.Fatal(e)
	}
	v, e := s.Usage("u", time.Time{}, time.Now().Add(time.Hour))
	if e != nil || v.RawBytes != 10 || v.WeightedBytes != 20 || v.ProviderBytes != 70 {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestTenantIDsCannotCrossOwners(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{8}, 32))
	defer s.Close()
	if e := s.TenantPut("alice", "sources", "same", map[string]string{"content": "private"}); e != nil {
		t.Fatal(e)
	}
	var v map[string]string
	if e := s.TenantGet("bob", "sources", "same", &v); e != store.ErrNotFound {
		t.Fatalf("cross-owner data: %+v %v", v, e)
	}
	l, e := s.TenantList("bob", "sources")
	if e != nil || len(l) != 0 {
		t.Fatal("cross-owner list")
	}
}

func TestFractionalRateRoundsAfterAggregation(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{2}, 32))
	defer s.Close()
	s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true})
	now := time.Now().UTC()
	s.SetRate(service.Rate{ID: "half", RouteID: "r", Micros: 500000, EffectiveAt: now.Add(-time.Hour)})
	for seq := uint64(1); seq <= 2; seq++ {
		if e := s.RecordMeter(store.MeterBatch{UserID: "u", RouteID: "r", MeterID: "m", Epoch: "boot", Sequence: seq, ObservedAt: now, RawBytes: 1}); e != nil {
			t.Fatal(e)
		}
	}
	v, e := s.Usage("u", time.Time{}, now.Add(time.Hour))
	if e != nil || v.WeightedBytes != 1 {
		t.Fatalf("two half-byte charges should total one byte, got %+v %v", v, e)
	}
}

// RW-13.1's GB example is decimal, not GiB. The binary case also crosses the
// signed 32-bit boundary after weighting; neither case transfers real traffic.
func TestMeterGigabyteAtDoubleRateDebitsOnceAndKeepsHistoricalRate(t *testing.T) {
	for _, tt := range []struct {
		name     string
		raw      int64
		weighted int64
	}{
		{"decimal-GB", 1_000_000_000, 2_000_000_000},
		{"binary-GiB", 1_073_741_824, 2_147_483_648},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{7}, 32))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if err := s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true}); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			if err := s.SetRate(service.Rate{ID: "double", RouteID: "r", Micros: 2_000_000, EffectiveAt: now.Add(-time.Hour)}); err != nil {
				t.Fatal(err)
			}
			batch := store.MeterBatch{UserID: "u", RouteID: "r", MeterID: "entry", Epoch: "boot", Sequence: 1, RawBytes: tt.raw, ProviderBytes: 7_000_000_000, ObservedAt: now}
			assertUsage := func(stage string) {
				t.Helper()
				got, err := s.Usage("u", time.Time{}, time.Time{})
				if err != nil || got.RawBytes != tt.raw || got.WeightedBytes != tt.weighted || got.ProviderBytes != 7_000_000_000 {
					t.Fatalf("%s: want raw=%d weighted=%d provider=7000000000, got %+v: %v", stage, tt.raw, tt.weighted, got, err)
				}
			}
			if err := s.RecordMeter(batch); err != nil {
				t.Fatal(err)
			}
			assertUsage("first measurement")
			if err := s.RecordMeter(batch); err != nil {
				t.Fatal(err)
			}
			assertUsage("identical replay")
			// Even a later policy revision effective before this observation must
			// not reprice an already-recorded measurement or its exact replay.
			if err := s.SetRate(service.Rate{ID: "single", RouteID: "r", Micros: 1_000_000, EffectiveAt: now.Add(-time.Minute)}); err != nil {
				t.Fatal(err)
			}
			assertUsage("policy revision")
			if err := s.RecordMeter(batch); err != nil {
				t.Fatal(err)
			}
			assertUsage("replay after policy revision")
			conflict := batch
			conflict.RawBytes++
			if err := s.RecordMeter(conflict); err == nil {
				t.Fatal("conflicting replay accepted")
			}
			assertUsage("rejected conflicting replay")
		})
	}
}
