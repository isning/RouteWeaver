package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A zero-byte final is the observed failed-reference shape, not proof of a
// completed native snapshot. Never retire the baseline, invent counters, or
// acknowledge retained transport obligations from that shape.
func TestManagedEmptyFinalPreservesEvidenceAndPendingAcrossReopen(t *testing.T) {
	root := t.TempDir()
	scope := testDesired(t, 1).Scope
	spoolPath := filepath.Join(root, "spool")
	spool, err := OpenMeterSpool(spoolPath, scope, "partial-final")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	writeRetentionSnapshot(t, root, "baseline", retentionSnapshot(now, "epoch-partial", 1, 0))
	if err := CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	before := spool.Pending()
	if len(before) != 1 {
		t.Fatal("expected unacknowledged real baseline")
	}
	dir := ManagedJournalDirectory(root)
	finalPath := filepath.Join(dir, "epoch-partial.final.json")
	if err := os.WriteFile(finalPath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	marker := []byte(`{"counterEpoch":"epoch-partial"}`)
	if err := os.WriteFile(filepath.Join(dir, "running.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	for pass := 0; pass < 2; pass++ {
		if err := CollectManagedCounters(context.Background(), root, spool, false); err == nil {
			t.Fatal("empty final accepted")
		}
		after := spool.Pending()
		if len(after) != len(before) || after[0].Digest != before[0].Digest || after[0].Sequence != before[0].Sequence {
			t.Fatal("pending obligation changed")
		}
		for _, name := range []string{"epoch-partial.baseline.json", "epoch-partial.final.json", "running.json"} {
			if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
				t.Fatal("retained evidence removed", err)
			}
		}
		if err := spool.Close(); err != nil {
			t.Fatal(err)
		}
		if pass == 0 {
			spool, err = OpenMeterSpool(spoolPath, scope, "partial-final")
			if err != nil {
				t.Fatal(err)
			}
		}
	}
}
