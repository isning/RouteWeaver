package managedxray_test

import (
	"os"
	"path/filepath"
	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
	"testing"
)

func TestJournalRequiresRealBaselineAndCleanFinalBeforeNewEpoch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "journal")
	s := entrypolicy.Snapshot{CounterEpoch: "epoch-a", Counters: []entrypolicy.Counter{{CounterEpoch: "epoch-a-binding"}}}
	j, e := managed.BeginJournal(dir, s)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = managed.BeginJournal(dir, s); e == nil {
		t.Fatal("unclean epoch silently replaced")
	}
	if _, e = os.Stat(filepath.Join(dir, "epoch-a.baseline.json")); e != nil {
		t.Fatal(e)
	}
	s.Counters[0].CumulativeBytes = 10
	if e = j.Finish(s); e != nil {
		t.Fatal(e)
	}
	s.CounterEpoch = "epoch-b"
	if _, e = managed.BeginJournal(dir, s); e == nil {
		t.Fatal("invented nonzero baseline accepted")
	}
	s.Counters[0].CumulativeBytes = 0
	if _, e = managed.BeginJournal(dir, s); e != nil {
		t.Fatal(e)
	}
}

func TestJournalRejectsTrafficOrInconsistentZeroBeforeStartup(t *testing.T) {
	for name, snapshot := range map[string]entrypolicy.Snapshot{
		"active flow":       {CounterEpoch: "epoch-active", ActiveFlows: 1, Counters: []entrypolicy.Counter{{}}},
		"nonzero direction": {CounterEpoch: "epoch-direction", Counters: []entrypolicy.Counter{{UploadBytes: 1}}},
		"missing counters":  {CounterEpoch: "epoch-empty"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := managed.BeginJournal(filepath.Join(t.TempDir(), "journal"), snapshot); err == nil {
				t.Fatal("invalid initial snapshot accepted")
			}
		})
	}
}
