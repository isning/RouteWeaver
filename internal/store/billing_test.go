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
