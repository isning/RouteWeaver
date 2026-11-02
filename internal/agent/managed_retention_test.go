package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/privateipc"
)

// These are genuine journal shapes: a pre-listener zero and a later quiescent
// final, not the ACK-only zero epochs that cannot establish safe retirement.
func writeRetentionSnapshot(t *testing.T, root, kind string, s entrypolicy.Snapshot) {
	t.Helper()
	dir := ManagedJournalDirectory(root)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, s.CounterEpoch+"."+kind+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func retentionSnapshot(at time.Time, epoch string, n int, value uint64) entrypolicy.Snapshot {
	s := managedSnapshot(at, value)
	s.CounterEpoch = epoch
	template := s.Counters[0]
	s.Counters = make([]entrypolicy.Counter, n)
	for i := range s.Counters {
		c := template
		c.SubjectID = fmt.Sprintf("subject-%04d", i)
		c.CounterEpoch = fmt.Sprintf("%s-%016x", epoch, i)
		s.Counters[i] = c
	}
	return s
}

// Synthetic exact custody receipts exercise local GC; joined store/HTTP tests
// separately prove actual CP persistence, retrieval and unchanged obligations.
func ackRetention(t *testing.T, spool *MeterSpool) {
	t.Helper()
	for _, b := range spool.Pending() {
		receipt := MeterReceipt{StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest}
		if b.TerminalEvidence != nil {
			receipt.CustodyVersion = entrypolicy.TerminalCustodyVersion
			receipt.TerminalEvidenceDigest = b.TerminalEvidence.Digest
		}
		if err := spool.Ack(receipt); err != nil {
			t.Fatal(err)
		}
	}
}
func TestManagedFinalReceiptCompactionBoundsLongRunningCollection(t *testing.T) {
	root := t.TempDir()
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), testDesired(t, 1).Scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC()
	for epoch := 0; epoch < 100; epoch++ {
		id := fmt.Sprintf("%032x", epoch)
		writeRetentionSnapshot(t, root, "baseline", retentionSnapshot(now.Add(time.Duration(epoch)*time.Second), id, 1000, 0))
		writeRetentionSnapshot(t, root, "final", retentionSnapshot(now.Add(time.Duration(epoch)*time.Second+time.Millisecond), id, 1000, 17))
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			t.Fatalf("epoch %d: %v", epoch, err)
		}
		batches := spool.Pending()
		if len(batches) != 2 || batches[0].Samples[0].CumulativeBytes != 0 || batches[1].Samples[0].CumulativeBytes != 17 {
			t.Fatalf("epoch %d lost baseline/final: %d", epoch, len(batches))
		}
		ackRetention(t, spool)
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			t.Fatal(err)
		}
		ackRetention(t, spool)
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			t.Fatal(err)
		}
		if len(spool.Pending()) != 0 {
			t.Fatal("retirement replayed acknowledged evidence")
		}
	}
	raw, err := os.ReadFile(filepath.Join(root, "spool", "meter.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > 64<<10 {
		t.Fatalf("settled history retained %d bytes", len(raw))
	}
	entries, err := os.ReadDir(ManagedJournalDirectory(root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("settled journals retained %d files", len(entries))
	}
}

func TestManagedRetirementWaitsForFinalAndExactReceipt(t *testing.T) {
	root := t.TempDir()
	scope := testDesired(t, 1).Scope
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC()
	baseline := retentionSnapshot(now, "epoch-one", 1, 0)
	writeRetentionSnapshot(t, root, "baseline", baseline)
	collect := func() {
		t.Helper()
		if err := CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			t.Fatal(err)
		}
	}
	collect()
	ackRetention(t, spool)
	collect()
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-one.baseline.json")); err != nil {
		t.Fatal("ACK alone retired active epoch", err)
	}
	final := retentionSnapshot(now.Add(time.Second), "epoch-one", 1, 37)
	writeRetentionSnapshot(t, root, "final", final)
	collect()
	b := spool.Pending()
	if len(b) != 1 || b[0].Samples[0].CumulativeBytes != 37 {
		t.Fatal("unsettled final lost")
	}
	if err = spool.Ack(MeterReceipt{StreamEpoch: b[0].StreamEpoch, Sequence: b[0].Sequence, Digest: "wrong"}); err == nil {
		t.Fatal("inexact receipt accepted")
	}
	collect()
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-one.final.json")); err != nil {
		t.Fatal("unacknowledged final removed", err)
	}
	spool.Close()
	spool, err = OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	collect()
	if len(spool.Pending()) != 1 {
		t.Fatal("restart duplicated final")
	}
	ackRetention(t, spool)
	collect()
	ackRetention(t, spool)
	collect()
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-one.final.json")); !os.IsNotExist(err) {
		t.Fatal("settled final not retired", err)
	}
}

func TestManagedRetirementPreservesRunningAndRejectsMalformedMarker(t *testing.T) {
	for _, marker := range []string{`{"counterEpoch":"epoch-one"}`, `{"counterEpoch":"../escape"}`, `not-json`} {
		t.Run(marker, func(t *testing.T) {
			root := t.TempDir()
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), testDesired(t, 1).Scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			defer spool.Close()
			now := time.Now().UTC()
			writeRetentionSnapshot(t, root, "baseline", retentionSnapshot(now, "epoch-one", 1, 0))
			writeRetentionSnapshot(t, root, "final", retentionSnapshot(now.Add(time.Second), "epoch-one", 1, 0))
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			ackRetention(t, spool)
			if err = os.WriteFile(filepath.Join(ManagedJournalDirectory(root), "running.json"), []byte(marker), 0600); err != nil {
				t.Fatal(err)
			}
			err = CollectManagedCounters(context.Background(), root, spool, false)
			if marker != `{"counterEpoch":"epoch-one"}` && err == nil {
				t.Fatal("malformed marker did not block collection")
			}
			if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-one.baseline.json")); err != nil {
				t.Fatal("running or unknown epoch deleted", err)
			}
		})
	}
}

// Construct the durable image at each interruption boundary, then exercise
// public reopen/collection. No test-only crash hooks enter production code.
func prepareRetirementCrash(t *testing.T, root string) (Scope, string) {
	t.Helper()
	scope := testDesired(t, 1).Scope
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	baseline := retentionSnapshot(now, "epoch-crash", 1, 0)
	final := retentionSnapshot(now.Add(time.Second), "epoch-crash", 1, 23)
	writeRetentionSnapshot(t, root, "baseline", baseline)
	writeRetentionSnapshot(t, root, "final", final)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	spool.Close()
	path := filepath.Join(root, "spool", "meter.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	baseRaw, _ := json.Marshal(baseline)
	finalRaw, _ := json.Marshal(final)
	c := final.Counters[0]
	intent := map[string]any{"scope": scope, "custody": state["terminalCustody"].(map[string]any)["epoch-crash"], "epoch": "epoch-crash", "directory": ManagedJournalDirectory(root), "acked": state["acked"], "baselineDigest": journalDigest(baseRaw), "finalDigest": journalDigest(finalRaw), "keys": []string{c.CounterEpoch + "\x00" + c.SubjectID + "\x00" + c.RouteID + "\x00" + c.MeasurementLayer}}
	raw, err = json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "spool", "managed-retirement.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return scope, path
}
func TestManagedRetirementCrashReopenNeverReplaysAcknowledgedEpoch(t *testing.T) {
	for removed := 0; removed <= 3; removed++ {
		t.Run(fmt.Sprint(removed), func(t *testing.T) {
			root := t.TempDir()
			scope, path := prepareRetirementCrash(t, root)
			for _, kind := range []string{"baseline", "final"}[:min(removed, 2)] {
				if err := os.Remove(filepath.Join(ManagedJournalDirectory(root), "epoch-crash."+kind+".json")); err != nil {
					t.Fatal(err)
				}
			}
			if removed == 3 {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				var state map[string]any
				if err = json.Unmarshal(raw, &state); err != nil {
					t.Fatal(err)
				}
				delete(state, "managedSources")
				delete(state, "terminalCustody")
				raw, err = json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			if len(spool.Pending()) != 0 {
				t.Fatal("acknowledged epoch replayed across retirement crash")
			}
			spool.Close()
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(raw) > 2048 {
				t.Fatal("recovered retirement retained cursors")
			}
			spool, err = OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			defer spool.Close()
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil || len(spool.Pending()) != 0 {
				t.Fatal("post-compaction restart replay", err)
			}
		})
	}
}
func TestManagedRetirementRecoveryRejectsChangedEvidenceAndUnsafePaths(t *testing.T) {
	for _, mutation := range []string{"final-changed", "running", "malformed-marker", "symlink-final", "symlink-directory", "wrong-root"} {
		t.Run(mutation, func(t *testing.T) {
			root := t.TempDir()
			scope, _ := prepareRetirementCrash(t, root)
			dir := ManagedJournalDirectory(root)
			collectRoot := root
			switch mutation {
			case "final-changed":
				if err := os.WriteFile(filepath.Join(dir, "epoch-crash.final.json"), []byte(`{}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "running":
				if err := os.WriteFile(filepath.Join(dir, "running.json"), []byte(`{"counterEpoch":"epoch-crash"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "malformed-marker":
				if err := os.WriteFile(filepath.Join(dir, "running.json"), []byte(`{`), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink-final":
				target := filepath.Join(t.TempDir(), "preserve")
				if err := os.WriteFile(target, []byte("outside"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(dir, "epoch-crash.final.json")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(dir, "epoch-crash.final.json")); err != nil {
					t.Fatal(err)
				}
			case "symlink-directory":
				moved := dir + "-moved"
				if err := os.Rename(dir, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, dir); err != nil {
					t.Fatal(err)
				}
			case "wrong-root":
				collectRoot = t.TempDir()
				if err := os.Mkdir(ManagedJournalDirectory(collectRoot), 0700); err != nil {
					t.Fatal(err)
				}
			}
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			defer spool.Close()
			if err = CollectManagedCounters(context.Background(), collectRoot, spool, false); err == nil {
				t.Fatal("unsafe retirement accepted")
			}
			if _, err = os.Stat(filepath.Join(dir, "epoch-crash.baseline.json")); err != nil {
				t.Fatal("baseline deleted despite unsafe retirement", err)
			}
		})
	}
}

func TestManagedRetirementCanRecoverLegacyOutboxAtByteLimit(t *testing.T) {
	root := t.TempDir()
	scope, path := prepareRetirementCrash(t, root)
	// Remove the prepared WAL: this case must create a new retirement intent
	// while the legacy meter file has less spare room than that intent needs.
	if err := os.Remove(filepath.Join(root, "spool", "managed-retirement.json")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	sources := state["managedSources"].(map[string]any)
	cursor := map[string]any{"value": "0", "observedAt": "2026-10-31T00:00:00Z"}
	padding := strings.Repeat("s", 800)
	for i := 0; i < 9000; i++ {
		sources[fmt.Sprintf("unclosed-%05d\x00%s\x00route\x00layer", i, padding)] = cursor
	}
	raw, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	remaining := (8 << 20) - 128 - len(raw)
	if remaining <= 100 {
		t.Fatalf("fixture has no headroom: %d", remaining)
	}
	filler, _ := json.Marshal(cursor)
	sources[strings.Repeat("f", remaining-len(filler)-4)] = cursor
	raw, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > 8<<20 || len(raw) < (8<<20)-256 {
		t.Fatalf("fixture not near byte limit: %d", len(raw))
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal("legacy compaction needs outbox headroom:", err)
	}
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-crash.final.json")); !os.IsNotExist(err) {
		t.Fatal("legacy closed epoch not compacted", err)
	}
	if len(spool.Pending()) != 0 {
		t.Fatal("legacy acknowledged final replayed")
	}
}

func TestManagedRetirementRejectsIncompleteOrChangedFinal(t *testing.T) {
	for _, change := range []string{"active-flow", "missing-binding", "changed-binding", "regressed-total"} {
		t.Run(change, func(t *testing.T) {
			root := t.TempDir()
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), testDesired(t, 1).Scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			defer spool.Close()
			now := time.Now().UTC()
			baseline := retentionSnapshot(now, "epoch-one", 2, 0)
			writeRetentionSnapshot(t, root, "baseline", baseline)
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			ackRetention(t, spool)
			final := retentionSnapshot(now.Add(time.Second), "epoch-one", 2, 7)
			switch change {
			case "active-flow":
				final.ActiveFlows = 1
			case "missing-binding":
				final.Counters = final.Counters[:1]
			case "changed-binding":
				final.Counters[0].PolicyRevision = "another-policy"
			case "regressed-total":
				final.Counters[0].CumulativeBytes = 6
			}
			writeRetentionSnapshot(t, root, "final", final)
			if err = CollectManagedCounters(context.Background(), root, spool, false); err == nil {
				t.Fatal("invalid final accepted")
			}
			if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-one.baseline.json")); err != nil {
				t.Fatal("invalid final destroyed baseline", err)
			}
		})
	}
}
func TestManagedRetirementCancellationPreservesRecoveryIntent(t *testing.T) {
	root := t.TempDir()
	scope, _ := prepareRetirementCrash(t, root)
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = CollectManagedCounters(ctx, root, spool, false); err != context.Canceled {
		t.Fatal("canceled collection continued", err)
	}
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-crash.baseline.json")); err != nil {
		t.Fatal("canceled collection removed evidence", err)
	}
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
}

// The external runtime side of real inherited pipes can briefly keep answering
// after its final journal is durable but before IPC closes.
type finalSnapshotController struct{ snapshot entrypolicy.Snapshot }

func (c finalSnapshotController) Snapshot() entrypolicy.Snapshot { return c.snapshot }
func (finalSnapshotController) RevokeAccount(string)             {}
func TestManagedRetirementRejectsStaleLiveZeroSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), testDesired(t, 1).Scope, "retention")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC()
	writeRetentionSnapshot(t, root, "baseline", retentionSnapshot(now, "epoch-final", 1, 0))
	final := retentionSnapshot(now.Add(time.Second), "epoch-final", 1, 0)
	writeRetentionSnapshot(t, root, "final", final)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	broker, err := StartAdmissionBroker(root, diagnosticFenceAuthority{})
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	pipes, err := prepareManagedPipes(Staged{Root: root, Desired: testDesired(t, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer pipes.OnExit()
	child := privateipc.NewDuplex(pipes.ExtraFiles[2], pipes.ExtraFiles[3])
	defer child.Close()
	done := make(chan struct{})
	go func() { defer close(done); privateipc.ServeControl(child, finalSnapshotController{final}) }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = CollectManagedCounters(ctx, root, spool, true); err == nil {
		t.Fatal("finalized epoch's live reply accepted")
	}
	if len(spool.Pending()) != 0 {
		t.Fatal("finalized zero snapshot was replayed after retirement")
	}
	child.Close()
	<-done
}
