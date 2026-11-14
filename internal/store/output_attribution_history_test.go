package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestOutputAttributionHistoryBounds(t *testing.T) {
	t.Run("snapshot and membership", func(t *testing.T) {
		s, _, _ := attributionFixture(t)
		kind := TenantKind("owner", "output-attribution-intents")
		if err := s.Put(kind, "actual-id", map[string]any{"id": "not-sql-id", "state": "cancelled"}); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(TenantKind("other", "output-attribution-intents"), "foreign", map[string]string{"state": "reserved"}); err != nil {
			t.Fatal(err)
		}
		records, set, err := s.ListOutputAttributionIntents("owner")
		if err != nil || len(records) != 1 || records[0].ID != "actual-id" || len(set.IDs) != 1 || set.IDs[0] != "actual-id" {
			t.Fatalf("%+v %+v %v", records, set, err)
		}
		if _, ok := records[0].Expected.(json.RawMessage); !ok {
			t.Fatal("not raw JSON")
		}
		if err = s.CompareSetsAndPutRecords(records, []RecordSetCompare{set}, nil); err != nil {
			t.Fatal(err)
		}
		if err = s.Put(kind, "new-id", map[string]string{"state": "reserved"}); err != nil {
			t.Fatal(err)
		}
		if err = s.CompareSetsAndPutRecords(records, []RecordSetCompare{set}, nil); !errors.Is(err, ErrConflict) {
			t.Fatalf("membership not fenced: %v", err)
		}
	})
	t.Run("rows", func(t *testing.T) {
		s, _, _ := attributionFixture(t)
		kind := TenantKind("owner", "output-attribution-intents")
		writes := make([]RecordWrite, 1000)
		for i := range writes {
			writes[i] = RecordWrite{Kind: kind, ID: fmt.Sprintf("output-%04d", i), Value: map[string]string{"state": "cancelled"}}
		}
		if err := s.CompareAndPutRecords(nil, writes); err != nil {
			t.Fatal(err)
		}
		records, set, err := s.ListOutputAttributionIntents("owner")
		if err != nil || len(records) != 1000 || len(set.IDs) != 1000 {
			t.Fatalf("boundary: %d %v", len(records), err)
		}
		if err = s.Put(kind, "overflow", map[string]string{"state": "cancelled"}); err != nil {
			t.Fatal(err)
		}
		records, set, err = s.ListOutputAttributionIntents("owner")
		if !errors.Is(err, ErrAttributionCapacity) || records != nil || set.Kind != "" {
			t.Fatalf("partial/excess: %d %+v %v", len(records), set, err)
		}
	})
	for _, many := range []bool{false, true} {
		t.Run(fmt.Sprintf("bytes-many-%v", many), func(t *testing.T) {
			s, _, _ := attributionFixture(t)
			n, size := 1, outputAttributionHistoryBytes
			if many {
				n, size = 3, 3<<20
			}
			for i := 0; i < n; i++ {
				if err := s.Put(TenantKind("owner", "output-attribution-intents"), fmt.Sprintf("output-%d", i), map[string]string{"plan": strings.Repeat("x", size)}); err != nil {
					t.Fatal(err)
				}
			}
			records, set, err := s.ListOutputAttributionIntents("owner")
			if !errors.Is(err, ErrAttributionCapacity) || records != nil || set.Kind != "" {
				t.Fatalf("partial/excess: %d %v", len(records), err)
			}
		})
	}
}
