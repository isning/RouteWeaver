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

func TestRelatedRecordsRemovalRollsBackEveryDelete(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{24}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	target := map[string]string{"id": "profile", "name": "Draft"}
	binding := map[string]string{"id": "profiles_profile", "templateId": "library"}
	if err = s.Put("profiles", "profile", target); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("template-bindings", "profiles_profile", binding); err != nil {
		t.Fatal(err)
	}
	compares := []store.RecordCompare{
		{Kind: "profiles", ID: "profile", Expected: target},
		{Kind: "template-bindings", ID: "profiles_profile", Expected: binding},
		{Kind: "template-bindings", ID: "missing", Expected: nil},
	}
	removals := []store.RecordDelete{{Kind: "profiles", ID: "profile"}, {Kind: "template-bindings", ID: "profiles_profile"}}
	// Failure after both real removals must roll back the entire transaction.
	err = s.CompareSetsAndRemoveRecords(append(removals, store.RecordDelete{Kind: "template-bindings", ID: "missing"}), compares, nil)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing final removal: %v", err)
	}
	for _, record := range removals {
		var got map[string]string
		if err = s.Get(record.Kind, record.ID, &got); err != nil {
			t.Fatalf("failed transaction partially removed %s: %v", record.Kind, err)
		}
	}
	if err = s.CompareSetsAndRemoveRecords(removals, compares, nil); err != nil {
		t.Fatal(err)
	}
	for _, record := range removals {
		var got map[string]string
		if err = s.Get(record.Kind, record.ID, &got); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("successful transaction retained %s: %v", record.Kind, err)
		}
	}
}

func TestRelatedRecordsRemovalFencesConcurrentBindingChanges(t *testing.T) {
	for _, initial := range []string{"absent", "present"} {
		t.Run(initial, func(t *testing.T) {
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
			target := map[string]string{"id": "collection", "name": "Unchanged draft"}
			binding := map[string]string{"id": "collections_collection", "templateId": "original"}
			if err = s.Put("collections", "collection", target); err != nil {
				t.Fatal(err)
			}
			compares := []store.RecordCompare{{Kind: "collections", ID: "collection", Expected: target}, {Kind: "template-bindings", ID: "collections_collection", Expected: nil}}
			removals := []store.RecordDelete{{Kind: "collections", ID: "collection"}}
			if initial == "present" {
				if err = s.Put("template-bindings", "collections_collection", binding); err != nil {
					t.Fatal(err)
				}
				compares[1].Expected = binding
				removals = append(removals, store.RecordDelete{Kind: "template-bindings", ID: "collections_collection"})
			}
			// A separate connection selects/replaces the relationship after delete
			// inspected it, without changing the target payload at all.
			changed := map[string]string{"id": "collections_collection", "templateId": "replacement"}
			if err = other.Put("template-bindings", "collections_collection", changed); err != nil {
				t.Fatal(err)
			}
			if err = s.CompareSetsAndRemoveRecords(removals, compares, nil); !errors.Is(err, store.ErrConflict) {
				t.Fatalf("stale relationship deletion: %v", err)
			}
			var got map[string]string
			if err = other.Get("collections", "collection", &got); err != nil || got["name"] != "Unchanged draft" {
				t.Fatalf("conflict removed or changed target: %v", err)
			}
			if err = other.Get("template-bindings", "collections_collection", &got); err != nil || got["templateId"] != "replacement" {
				t.Fatalf("conflict removed or changed newer relationship: %v", err)
			}
			compares[1].Expected = changed
			removals = []store.RecordDelete{{Kind: "collections", ID: "collection"}, {Kind: "template-bindings", ID: "collections_collection"}}
			if err = s.CompareSetsAndRemoveRecords(removals, compares, nil); err != nil {
				t.Fatalf("fresh relationship deletion: %v", err)
			}
			for _, record := range removals {
				if err = other.Get(record.Kind, record.ID, &got); !errors.Is(err, store.ErrNotFound) {
					t.Fatalf("atomic deletion not visible from independent handle for %s: %v", record.Kind, err)
				}
			}
		})
	}
}
