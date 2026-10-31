package store_test

import (
	"bytes"
	"database/sql"
	"errors"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestOversizedLegacyNotificationRefusedBeforeDecryption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{91}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	fixture, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()
	if _, err = fixture.Exec(`PRAGMA journal_mode=DELETE`); err != nil {
		t.Fatal(err)
	}
	// SQLite allocates a zero-blob on disk; Go never materializes this ciphertext.
	const size = (64 << 20) + 29
	if _, err = fixture.Exec(`INSERT INTO records(kind,id,data) VALUES('notification-private','state',zeroblob(?))`, size); err != nil {
		t.Fatal(err)
	}
	var before []byte
	if err = fixture.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	opened, err := store.Open(path, key)
	if err == nil {
		opened.Close()
		t.Fatal("oversized legacy row opened")
	}
	if !errors.Is(err, store.ErrLegacyNotificationLimit) {
		t.Fatalf("oversized row reached encryption/decode instead of preflight bound: %v", err)
	}
	var after []byte
	var n int
	if err = fixture.QueryRow(`SELECT data FROM records WHERE kind='metadata' AND id='key-check'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err = fixture.QueryRow(`SELECT length(data) FROM records WHERE kind='notification-private' AND id='state'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != size || !bytes.Equal(before, after) {
		t.Fatal("refusal changed original encrypted facts")
	}
	var journal string
	if err = fixture.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil || journal != "delete" {
		t.Fatalf("oversize refusal changed original journal mode: %s %v", journal, err)
	}

}
