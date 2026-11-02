package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/entrypolicy"
)

func TestManagedTerminalCustodyRequiresExplicitACKAndReopensBeforeGC(t *testing.T) {
	for _, value := range []uint64{0, 37} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			root := t.TempDir()
			scope := testDesired(t, 1).Scope
			path := filepath.Join(root, "spool")
			spool, err := OpenMeterSpool(path, scope, "terminal")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { spool.Close() }()
			now := time.Now().UTC()
			base := retentionSnapshot(now, "terminal-epoch", 1, 0)
			writeRetentionSnapshot(t, root, "baseline", base)
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			ackRetention(t, spool)
			live := retentionSnapshot(now.Add(time.Second), "terminal-epoch", 1, value)
			live.ActiveFlows = 1
			if err = spool.EnqueueManagedSnapshot(live); err != nil {
				t.Fatal(err)
			}
			ackRetention(t, spool)
			final := retentionSnapshot(now.Add(2*time.Second), "terminal-epoch", 1, value)
			writeRetentionSnapshot(t, root, "final", final)
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			pending := spool.Pending()
			if len(pending) != 1 || pending[0].TerminalEvidence == nil || len(pending[0].Samples) != 0 {
				t.Fatal("zero-delta closure needs distinct terminal-only delivery")
			}
			b := pending[0]
			receipt := MeterReceipt{StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest}
			for _, bad := range []MeterReceipt{receipt, {StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest, CustodyVersion: 1, TerminalEvidenceDigest: "wrong"}, {StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest, CustodyVersion: 2, TerminalEvidenceDigest: b.TerminalEvidence.Digest}} {
				if err = spool.Ack(bad); err == nil {
					t.Fatal("legacy/wrong terminal acknowledgement accepted")
				}
			}
			// Loss/retry before ACK preserves the exact proof, including its sequence.
			spool.Close()
			spool, err = OpenMeterSpool(path, scope, "terminal")
			if err != nil {
				t.Fatal(err)
			}
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			retried := spool.Pending()
			if len(retried) != 1 || retried[0].Digest != b.Digest {
				t.Fatal("proof replay changed identity")
			}
			receipt.CustodyVersion = entrypolicy.TerminalCustodyVersion
			receipt.TerminalEvidenceDigest = b.TerminalEvidence.Digest
			if err = spool.Ack(receipt); err != nil {
				t.Fatal(err)
			}
			// Crash after typed ACK but before the retirement WAL must still recover.
			spool.Close()
			spool, err = OpenMeterSpool(path, scope, "terminal")
			if err != nil {
				t.Fatal(err)
			}
			if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
				t.Fatal(err)
			}
			snapshots, err := ReadManagedJournal(root)
			if err != nil || len(snapshots) != 0 || len(spool.Pending()) != 0 {
				t.Fatal("custody did not allow safe GC", err)
			}
		})
	}
}

func TestManagedLegacyRetirementIntentNeverDeletesRemainingEvidence(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(map[bool]string{false: "intact", true: "partial"}[partial], func(t *testing.T) {
			root := t.TempDir()
			scope, _ := prepareRetirementCrash(t, root)
			wal := filepath.Join(root, "spool", "managed-retirement.json")
			raw, err := os.ReadFile(wal)
			if err != nil {
				t.Fatal(err)
			}
			var intent map[string]any
			if err = json.Unmarshal(raw, &intent); err != nil {
				t.Fatal(err)
			}
			delete(intent, "custody")
			delete(intent, "scope")
			raw, err = json.Marshal(intent)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(wal, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if partial {
				if err = os.Remove(filepath.Join(ManagedJournalDirectory(root), "epoch-crash.baseline.json")); err != nil {
					t.Fatal(err)
				}
			}
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
			if err != nil {
				t.Fatal(err)
			}
			defer spool.Close()
			if err = CollectManagedCounters(context.Background(), root, spool, false); err == nil {
				t.Fatal("legacy WAL acquired terminal semantics")
			}
			if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-crash.final.json")); err != nil {
				t.Fatal("remaining proof deleted", err)
			}
		})
	}
}

func TestMeterSpoolPersistsSchemaTwoDowngradeFence(t *testing.T) {
	root := filepath.Join(t.TempDir(), "spool")
	scope := testDesired(t, 1).Scope
	spool, err := OpenMeterSpool(root, scope, "schema")
	if err != nil {
		t.Fatal(err)
	}
	if err = spool.EnqueueManagedSnapshot(managedSnapshot(time.Now().UTC(), 0)); err != nil {
		t.Fatal(err)
	}
	spool.Close()
	path := filepath.Join(root, "meter.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	state["schema"] = 1
	raw, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	spool, err = OpenMeterSpool(root, scope, "schema")
	if err != nil {
		t.Fatal(err)
	}
	spool.Close()
	raw, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if state["schema"] != float64(2) {
		t.Fatal("downgrade fence was not durable before collection")
	}
}

func TestManagedTerminalRetirementRejectsMissingOrCorruptCustody(t *testing.T) {
	for _, mode := range []string{"map-missing", "map-sequence-zero", "map-digest-nonhex", "wal-digest-nonhex", "wal-receipt-conflict"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			scope, path := prepareRetirementCrash(t, root)
			target := path
			if strings.HasPrefix(mode, "wal-") {
				target = filepath.Join(root, "spool", "managed-retirement.json")
			}
			raw, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			var state map[string]any
			if err = json.Unmarshal(raw, &state); err != nil {
				t.Fatal(err)
			}
			var custody map[string]any
			if strings.HasPrefix(mode, "wal-") {
				custody = state["custody"].(map[string]any)
			} else {
				custody = state["terminalCustody"].(map[string]any)["epoch-crash"].(map[string]any)
			}
			receipt := custody["receipt"].(map[string]any)
			switch mode {
			case "map-missing":
				delete(state, "terminalCustody")
			case "map-sequence-zero":
				receipt["sequence"] = "0"
			case "map-digest-nonhex", "wal-digest-nonhex":
				receipt["digest"] = strings.Repeat("z", 64)
			case "wal-receipt-conflict":
				receipt["digest"] = strings.Repeat("a", 64)
			}
			raw, err = json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(target, raw, 0600); err != nil {
				t.Fatal(err)
			}
			spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention")
			if err == nil {
				defer spool.Close()
				if err = CollectManagedCounters(context.Background(), root, spool, false); err == nil {
					t.Fatal("corrupt custody authorized deletion")
				}
			}
			if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "epoch-crash.final.json")); err != nil {
				t.Fatal("final lost", err)
			}
		})
	}
}

func TestManagedTerminalTransportRejectsLegacyCPReceipt(t *testing.T) {
	root := t.TempDir()
	scope := testDesired(t, 1).Scope
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "transport")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC()
	writeRetentionSnapshot(t, root, "baseline", retentionSnapshot(now, "transport-epoch", 1, 0))
	writeRetentionSnapshot(t, root, "final", retentionSnapshot(now.Add(time.Second), "transport-epoch", 1, 0))
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	batch := spool.Pending()[0]
	for _, strict := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strict {
				var legacy struct {
					Scope       Scope         `json:"scope"`
					StreamEpoch string        `json:"streamEpoch"`
					Sequence    uint64        `json:"sequence,string"`
					Digest      string        `json:"digest"`
					Samples     []MeterSample `json:"samples"`
				}
				decoder := json.NewDecoder(r.Body)
				decoder.DisallowUnknownFields()
				if decoder.Decode(&legacy) != nil {
					http.Error(w, "unknown terminal field", 400)
					return
				}
				t.Error("legacy decoder accepted terminal field")
			}
			json.NewEncoder(w).Encode(MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest})
		}))
		tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "synthetic-token", Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		if _, err = tr.SendMeterBatch(context.Background(), batch); err == nil {
			t.Fatal("legacy CP acquired terminal custody semantics")
		}
		tr.Close()
		server.Close()
	}
	if len(spool.Pending()) != 1 {
		t.Fatal("failed custody delivery lost evidence")
	}
}

func TestManagedTerminalEvidenceOverflowRetainsJournals(t *testing.T) {
	root := t.TempDir()
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), testDesired(t, 1).Scope, "capacity")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC()
	base := retentionSnapshot(now, "capacity-epoch", 1000, 0)
	for i := range base.Counters {
		base.Counters[i].InboundTag = strings.Repeat("i", 256)
		base.Counters[i].CredentialVersion = strings.Repeat("c", 256)
	}
	final := base
	final.Counters = append([]entrypolicy.Counter(nil), base.Counters...)
	final.ObservedAt = now.Add(time.Second)
	writeRetentionSnapshot(t, root, "baseline", base)
	writeRetentionSnapshot(t, root, "final", final)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	ackRetention(t, spool)
	if err = CollectManagedCounters(context.Background(), root, spool, false); err == nil {
		t.Fatal("oversized custody bypassed 1MiB limit")
	}
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "capacity-epoch.final.json")); err != nil {
		t.Fatal("overflow deleted final", err)
	}
	if len(spool.Pending()) != 0 {
		t.Fatal("undeliverable oversized batch persisted")
	}
}

func TestMeterSpoolCustodyCountBoundPrecedesMigration(t *testing.T) {
	root := t.TempDir()
	scope, path := prepareRetirementCrash(t, root)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	custody := state["terminalCustody"].(map[string]any)["epoch-crash"]
	entries := map[string]any{}
	for i := 0; i < 129; i++ {
		entries[fmt.Sprintf("retained-%d", i)] = custody
	}
	state["terminalCustody"] = entries
	state["schema"] = 1
	raw, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if spool, err := OpenMeterSpool(filepath.Join(root, "spool"), scope, "retention"); err == nil {
		spool.Close()
		t.Fatal("custody map exceeded bounded state")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(raw) {
		t.Fatal("invalid legacy state was rewritten before bounds validation")
	}
}

func TestManagedTerminalContractMatchesRegisteredRuntime(t *testing.T) {
	if ManagedXrayID != entrypolicy.TerminalManagedAdapter || ManagedXrayVersion != entrypolicy.TerminalManagedRuntime {
		t.Fatal("managed runtime registration and terminal-custody capability must be upgraded together")
	}
}
