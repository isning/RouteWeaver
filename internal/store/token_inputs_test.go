package store_test

import (
	"bytes"
	"errors"
	"path/filepath"
	"testing"

	"routeweaver/internal/store"
)

func TestTokenPublicationFencesCapturedInputsAndRollsBackIndex(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{18}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	before := map[string]string{"status": "published", "revision": "old"}
	next := map[string]string{"status": "published", "revision": "new"}
	source := map[string]string{"content": "old-source"}
	if err := s.Put("sources", "source", source); err != nil {
		t.Fatal(err)
	}
	if err := s.CompareAndPutWithToken("outputs", "output", nil, before, "feeds", "", "old-token", "owner/output"); err != nil {
		t.Fatal(err)
	}
	// Another writer changes an input after render captured it, but before the
	// output/index commit. The old output and token must survive as one unit.
	if err := s.Put("sources", "source", map[string]string{"content": "new-source"}); err != nil {
		t.Fatal(err)
	}
	compares := []store.RecordCompare{{Kind: "sources", ID: "source", Expected: source}}
	err = s.CompareInputsAndPutWithToken("outputs", "output", before, next, "feeds", "old-token", "new-token", "owner/output", compares, nil)
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale input accepted: %v", err)
	}
	var got map[string]string
	if err := s.Get("outputs", "output", &got); err != nil || got["revision"] != "old" {
		t.Fatalf("partial record write: %v %#v", err, got)
	}
	if got, err := s.LookupToken("feeds", "old-token"); err != nil || got != "owner/output" {
		t.Fatalf("old feed lost: %q %v", got, err)
	}
	if _, err := s.LookupToken("feeds", "new-token"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("new token became live: %v", err)
	}
	compares[0].Expected = map[string]string{"content": "new-source"}
	if err := s.CompareInputsAndPutWithToken("outputs", "output", before, next, "feeds", "old-token", "new-token", "owner/output", compares, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LookupToken("feeds", "old-token"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("old token survived successful commit")
	}
	if got, err := s.LookupToken("feeds", "new-token"); err != nil || got != "owner/output" {
		t.Fatal("new token missing after commit")
	}
}
