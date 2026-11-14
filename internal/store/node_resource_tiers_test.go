package store

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestResourceHistoryTiersAvoidHourlyRewriteAndRollbackTogether(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "tiers.db"), bytes.Repeat([]byte{4}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC().Truncate(time.Hour).Add(time.Minute)
	snapshot := observability.Snapshot{ObservedAt: now, Continuity: "continuous"}
	snapshot.Metrics.MemoryTotalBytes = 100
	snapshot.Metrics.MemoryAvailableBytes = 50
	appendAt := func(at time.Time, commit bool) {
		t.Helper()
		snapshot.ObservedAt = at
		tx, e := s.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback()
		if e = s.appendNodeResourceHistoryTx(tx, "node", snapshot, at); e != nil {
			t.Fatal(e)
		}
		if commit {
			if e = tx.Commit(); e != nil {
				t.Fatal(e)
			}
		}
	}
	raw := func(kind string) []byte {
		t.Helper()
		var b []byte
		if e := s.db.QueryRow(`SELECT data FROM records WHERE kind=? AND id='node'`, kind).Scan(&b); e != nil {
			t.Fatal(e)
		}
		return b
	}
	appendAt(now, true)
	fine, hourly := raw(nodeHistoryKind), raw(nodeHourlyKind)
	appendAt(now.Add(5*time.Minute), true)
	if bytes.Equal(fine, raw(nodeHistoryKind)) || !bytes.Equal(hourly, raw(nodeHourlyKind)) {
		t.Fatal("five-minute sample rewrote hourly tier or skipped fine tier")
	}
	fine = raw(nodeHistoryKind)
	appendAt(now.Add(time.Hour), false)
	if !bytes.Equal(fine, raw(nodeHistoryKind)) || !bytes.Equal(hourly, raw(nodeHourlyKind)) {
		t.Fatal("tier update escaped rollback")
	}
	appendAt(now.Add(time.Hour), true)
	if bytes.Equal(hourly, raw(nodeHourlyKind)) {
		t.Fatal("hourly snapshot not persisted")
	}
}
