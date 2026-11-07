package store_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"routeweaver/internal/store"
)

func TestRecordExistsDistinguishesAbsentAndUnreadableOccupiedSlots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, err := store.Open(path, bytes.Repeat([]byte{32}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if exists, err := s.RecordExists("fleet-batches", "batch"); err != nil || exists {
		t.Fatalf("fresh slot is not absent: %v %v", exists, err)
	}
	if err := s.Put("fleet-batches", "batch", map[string]string{"id": "batch"}); err != nil {
		t.Fatal(err)
	}
	if exists, err := s.RecordExists("fleet-batches", "batch"); err != nil || !exists {
		t.Fatalf("readable slot is not occupied: %v %v", exists, err)
	}
	// Damage ciphertext through the SQLite persistence seam. Presence must not
	// depend on successful decryption or on the record's JSON representation.
	fault, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`UPDATE records SET data=X'00' WHERE kind='fleet-batches' AND id='batch'`); err != nil {
		t.Fatal(err)
	}
	var raw json.RawMessage
	if err := s.Get("fleet-batches", "batch", &raw); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("fixture must be present but unreadable: %v", err)
	}
	if exists, err := s.RecordExists("fleet-batches", "batch"); err != nil || !exists {
		t.Fatalf("unreadable slot is not occupied: %v %v", exists, err)
	}
	for _, pair := range [][2]string{{"fleet-batches", "absent"}, {"other-kind", "batch"}, {"fleet-batches", "' OR 1=1 --"}} {
		if exists, err := s.RecordExists(pair[0], pair[1]); err != nil || exists {
			t.Fatalf("absent slot %q is not absent: %v %v", pair, exists, err)
		}
	}
	// Existence is advisory. The original atomic expected-absent fence remains
	// authoritative and also refuses to overwrite unreadable occupied records.
	err = s.CompareAndPutRecords([]store.RecordCompare{{Kind: "fleet-batches", ID: "batch"}}, []store.RecordWrite{{Kind: "fleet-batches", ID: "batch", Value: map[string]string{"id": "replacement"}}})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("expected-absent fence accepted unreadable occupied slot: %v", err)
	}
	if err := s.Get("fleet-batches", "batch", &raw); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("failed insertion changed unreadable occupied slot: %v", err)
	}
}

func TestRecordExistsPreservesDatabaseReadErrors(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{33}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if exists, err := s.RecordExists("fleet-batches", "batch"); err == nil || exists || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("database read error was mistaken for presence or absence: %v %v", exists, err)
	}
}
