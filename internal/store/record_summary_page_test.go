package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"routeweaver/internal/store"
)

func TestTenantSummaryBoundsAndIsolation(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 33; i++ {
		if err := s.TenantPut("owner", "outputs", fmt.Sprintf("%02d", i), map[string]string{"id": fmt.Sprintf("%02d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	rows, partial, err := s.TenantSummaryPage(context.Background(), "owner", "outputs", 32, 4096)
	if err != nil || len(rows) != 32 || !partial {
		t.Fatalf("limit+1: %d %v %v", len(rows), partial, err)
	}
	rows, partial, err = s.TenantSummaryPage(context.Background(), "other", "outputs", 32, 4096)
	if err != nil || len(rows) != 0 || partial {
		t.Fatalf("foreign inventory: %d %v %v", len(rows), partial, err)
	}
	rows, partial, err = s.TenantSummaryPage(context.Background(), "owner", "outputs", 32, 128)
	if err != nil || !partial || len(rows) >= 32 {
		t.Fatalf("total bytes: %d %v %v", len(rows), partial, err)
	}
	if err := s.TenantPut("owner", "sources", "large", map[string]string{"value": strings.Repeat("x", 4096)}); err != nil {
		t.Fatal(err)
	}
	var raw json.RawMessage
	if err := s.TenantSummaryGet("owner", "sources", "large", 512, &raw); err == nil || len(raw) != 0 {
		t.Fatalf("oversized accepted: %v", err)
	}
	if err := s.TenantSummaryGet("other", "sources", "large", 8192, &raw); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign record: %v", err)
	}
	if err := s.TenantSummaryGet("owner", "sources", "large", 8192, &raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), strings.Repeat("x", 4096)) {
		t.Fatal("owned record not returned")
	}
}
