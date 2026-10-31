package store_test

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
)

func TestUsageDedupAndQuota(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "state.db"), bytes.Repeat([]byte{1}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true, QuotaBytes: 100}); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e = s.RecordUsage("u", "batch-1", 60); e != nil {
			t.Fatal(e)
		}
	}
	state, e := s.State()
	if e != nil {
		t.Fatal(e)
	}
	if state.Users[0].UsedBytes != 60 {
		t.Fatalf("duplicate charged: %d", state.Users[0].UsedBytes)
	}
	if e = s.RecordUsage("u", "batch-2", 50); e == nil {
		t.Fatal("over-quota usage accepted")
	}
}
