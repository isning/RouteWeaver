package store_test

import (
	"bytes"
	"errors"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestRelatedRecordCASRetainsTargetWhenBindingChanges(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{21}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	original := map[string]any{"name": "Unchanged collection"}
	oldBinding := map[string]any{"mode": "follow", "version": 1}
	newBinding := map[string]any{"mode": "pinned", "version": 1}
	if e = s.Put("collections", "collection", original); e != nil {
		t.Fatal(e)
	}
	if e = s.Put("bindings", "collection", oldBinding); e != nil {
		t.Fatal(e)
	}
	if e = s.Put("bindings", "collection", newBinding); e != nil {
		t.Fatal(e)
	}
	e = s.CompareAndPutRecords([]store.RecordCompare{{Kind: "collections", ID: "collection", Expected: original}, {Kind: "bindings", ID: "collection", Expected: oldBinding}}, []store.RecordWrite{{Kind: "collections", ID: "collection", Value: map[string]any{"name": "Stale update"}}, {Kind: "bindings", ID: "collection", Value: oldBinding}})
	if !errors.Is(e, store.ErrConflict) {
		t.Fatalf("stale relationship accepted: %v", e)
	}
	var actual map[string]any
	if e = s.Get("collections", "collection", &actual); e != nil {
		t.Fatal(e)
	}
	if actual["name"] != "Unchanged collection" {
		t.Fatal("partial target write survived conflict")
	}
	var binding map[string]any
	s.Get("bindings", "collection", &binding)
	if binding["mode"] != "pinned" {
		t.Fatal("newer binding overwritten")
	}
}

func TestRelatedRecordCASCommitsTogetherAndRollsBackSerializationFailure(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{22}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	comparisons := []store.RecordCompare{{Kind: "targets", ID: "one"}, {Kind: "bindings", ID: "one"}}
	e = s.CompareAndPutRecords(comparisons, []store.RecordWrite{{Kind: "targets", ID: "one", Value: map[string]uint64{"generation": 9007199254740993}}, {Kind: "bindings", ID: "one", Value: make(chan int)}})
	if e == nil {
		t.Fatal("unserializable transaction accepted")
	}
	var raw map[string]uint64
	if e = s.Get("targets", "one", &raw); !errors.Is(e, store.ErrNotFound) {
		t.Fatal("partial write survived rollback")
	}
	e = s.CompareAndPutRecords(comparisons, []store.RecordWrite{{Kind: "targets", ID: "one", Value: map[string]uint64{"generation": 9007199254740993}}, {Kind: "bindings", ID: "one", Value: map[string]string{"mode": "follow"}}})
	if e != nil {
		t.Fatal(e)
	}
	e = s.CompareAndPutRecords([]store.RecordCompare{{Kind: "targets", ID: "one", Expected: map[string]uint64{"generation": 9007199254740992}}}, nil)
	if !errors.Is(e, store.ErrConflict) {
		t.Fatal("large integer CAS lost precision")
	}
}

func TestRelatedRecordCASFencesNewDependentMembership(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{24}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	reviewed := []store.RecordSetCompare{{Kind: "profiles", IDs: []string{}}}
	if err := s.Put("profiles", "new-dependent", map[string]string{"id": "new-dependent", "collectionId": "collection"}); err != nil {
		t.Fatal(err)
	}
	err = s.CompareSetsAndPutRecords(nil, reviewed, []store.RecordWrite{{Kind: "collections", ID: "collection", Value: map[string]string{"name": "unreviewed"}}})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("new dependent was not fenced: %v", err)
	}
	var out any
	if err := s.Get("collections", "collection", &out); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("stale write survived: %v", err)
	}
	reviewed[0].IDs = []string{"new-dependent"}
	if err := s.CompareSetsAndPutRecords(nil, reviewed, nil); err != nil {
		t.Fatal(err)
	}
}
