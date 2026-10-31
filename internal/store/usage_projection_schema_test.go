package store

import (
	"path/filepath"
	"testing"
)

func TestUsageProjectionSchemaTracksOnlyCanonicalLedger(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.db"), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	generation := func() int64 {
		var n int64
		if err := s.db.QueryRow(`SELECT generation FROM usage_projection_state WHERE id=1`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := generation()
	if err = s.Put("unrelated", "a", 1); err != nil {
		t.Fatal(err)
	}
	if generation() != before {
		t.Fatal("unrelated record dirtied usage")
	}
	if err = s.Put("ledger", "a", MeterRecord{}); err != nil {
		t.Fatal(err)
	}
	// UPSERT conflict policies also govern trigger statements. Replacing an
	// existing ledger row must not turn marker creation into a uniqueness error.
	if err = s.Put("ledger", "a", MeterRecord{}); err != nil {
		t.Fatal(err)
	}
	before++
	if generation() != before+1 {
		t.Fatal("ledger insert did not increment generation")
	}
	if _, err = s.db.Exec(`UPDATE records SET kind='old-ledger' WHERE kind='ledger'`); err != nil {
		t.Fatal(err)
	}
	if generation() != before+2 {
		t.Fatal("OLD ledger kind not tracked")
	}
	if _, err = s.db.Exec(`UPDATE records SET kind='ledger' WHERE kind='old-ledger'`); err != nil {
		t.Fatal(err)
	}
	if generation() != before+3 {
		t.Fatal("NEW ledger kind not tracked")
	}
	if _, err = s.db.Exec(`DELETE FROM records WHERE kind='ledger'`); err != nil {
		t.Fatal(err)
	}
	if generation() != before+4 {
		t.Fatal("ledger deletion not tracked")
	}
}
