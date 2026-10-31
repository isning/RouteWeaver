package store_test

import (
	"bytes"
	"errors"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestRelatedRecordDeleteCASFencesIndependentHandleChanges(t *testing.T) {
	for _, change := range []string{"membership", "payload", "target"} {
		t.Run(change, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "db")
			key := bytes.Repeat([]byte{24}, 32)
			s, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			other, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			original := map[string]string{"id": "source", "name": "Original"}
			dependent := map[string]string{"id": "profile", "sourceId": "elsewhere"}
			if err = s.Put("sources", "source", original); err != nil {
				t.Fatal(err)
			}
			if err = s.Put("profiles", "profile", dependent); err != nil {
				t.Fatal(err)
			}
			compares := []store.RecordCompare{{Kind: "sources", ID: "source", Expected: original}, {Kind: "profiles", ID: "profile", Expected: dependent}}
			sets := []store.RecordSetCompare{{Kind: "profiles", IDs: []string{"profile"}}}
			switch change {
			case "membership":
				err = other.Put("profiles", "new", map[string]string{"id": "new", "sourceId": "source"})
			case "payload":
				err = other.Put("profiles", "profile", map[string]string{"id": "profile", "sourceId": "source"})
			case "target":
				err = other.Put("sources", "source", map[string]string{"id": "source", "name": "Replaced"})
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = s.CompareSetsAndRemoveRecord("sources", "source", compares, sets); !errors.Is(err, store.ErrConflict) {
				t.Fatalf("stale delete: %v", err)
			}
			var source map[string]string
			if err = other.Get("sources", "source", &source); err != nil {
				t.Fatalf("conflict removed target: %v", err)
			}
			if change == "target" && source["name"] != "Replaced" {
				t.Fatal("replacement lost")
			}
			// Remove the fixture dependants, then an unchanged empty manifest must
			// permit deletion rather than merely rejecting every request.
			if err = other.Remove("profiles", "profile"); err != nil {
				t.Fatal(err)
			}
			if change == "membership" {
				if err = other.Remove("profiles", "new"); err != nil {
					t.Fatal(err)
				}
			}
			if err = s.CompareSetsAndRemoveRecord("sources", "source", []store.RecordCompare{{Kind: "sources", ID: "source", Expected: source}}, []store.RecordSetCompare{{Kind: "profiles", IDs: []string{}}}); err != nil {
				t.Fatal(err)
			}
			if err = other.Get("sources", "source", &source); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("successful deletion not visible: %v", err)
			}
		})
	}
}
