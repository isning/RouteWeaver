package store_test

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestSecondaryBackupRejectsMissingLiveFeedIndex(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{18}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.PutWithToken(store.TenantKind("owner", "outputs"), "feed", map[string]any{"id": "feed", "tokenDigest": "digest", "status": "published", "token": "synthetic-feed-token"}, "feeds", "", "digest", "owner/feed"); e != nil {
		t.Fatal(e)
	}
	snap, e := s.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	snap.Tokens = nil
	target := filepath.Join(t.TempDir(), "restored.db")
	if e = store.RestoreFresh(context.Background(), target, bytes.Repeat([]byte{19}, 32), snap); e == nil {
		t.Fatal("snapshot with active output but missing token index was restored")
	}
}
func TestSecondaryBackupRejectsMissingGenerationCounter(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{18}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	for i := 0; i < 3; i++ {
		if _, e = s.GenerateRecord("agent-desired", "instance", func(g uint64) (any, error) { return map[string]any{"generation": g}, nil }); e != nil {
			t.Fatal(e)
		}
	}
	snap, e := s.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	snap.Counters = nil
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{19}, 32)
	if e = store.RestoreFresh(context.Background(), target, key, snap); e == nil {
		restored, e := store.Open(target, key)
		if e != nil {
			t.Fatal(e)
		}
		defer restored.Close()
		generation, e := restored.GenerateRecord("agent-desired", "instance", func(g uint64) (any, error) { return map[string]any{"generation": g}, nil })
		t.Fatalf("missing generation fence accepted; next generation=%d, err=%v (was 3)", generation, e)
	}
}

func TestBackupGenerationFenceCannotRegressButTombstoneMayLead(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{18}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	for range 3 {
		if _, e = s.GenerateRecord("agent-desired", "instance", func(g uint64) (any, error) { return map[string]any{"generation": fmt.Sprintf("%d", g)}, nil }); e != nil {
			t.Fatal(e)
		}
	}
	snap, e := s.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	for i := range snap.Counters {
		if snap.Counters[i].Kind == "agent-desired" {
			snap.Counters[i].Value = 2
		}
	}
	if e = store.ValidateSnapshot(snap); e == nil {
		t.Fatal("behind generation fence accepted")
	}
	for i := range snap.Counters {
		if snap.Counters[i].Kind == "agent-desired" {
			snap.Counters[i].Value = 4
		}
	}
	if e = store.ValidateSnapshot(snap); e != nil {
		t.Fatalf("safe generation tombstone rejected: %v", e)
	}
}
