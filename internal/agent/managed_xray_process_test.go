//go:build linux

package agent

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

// This opt-in fixture joins real VLESS payload, the inherited-pipe broker,
// subprocess ownership and durable native counters. It uses no Unix sockets or
// real enrollment and never signals an unidentified process/group.
func TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal(t *testing.T) {
	source := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	if source == "" {
		t.Skip("explicit managed native executable required")
	}
	root, err := os.MkdirTemp("", "rw-managed-eof-")
	if err != nil {
		t.Fatal(err)
	}
	retain := false
	t.Cleanup(func() {
		if !retain {
			os.RemoveAll(root)
		}
	})
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "immutable-managed-core")
	if err = os.WriteFile(binary, content, 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := NewManagedXrayChecker(binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	desired := nativeDesired(t, ManagedXrayID, ManagedXrayVersion)
	reconciler, err := Open(root, desired.Scope, NewRegistry(supervisor), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	broker, err := StartAdmissionBroker(root, brokerAuthority{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		broker.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := supervisor.Stop(ctx, root); err != nil {
			retain = true
			t.Errorf("owned cleanup refused, retained %s: %v", root, err)
		}
		observation, observeErr := supervisor.Observe(ctx, root)
		absent := observeErr == nil && observation.Known && observation.Quiescent && observation.Generation == 0
		if !absent {
			retain = true
			t.Errorf("EOF cleanup owned absence unknown: %v", observeErr)
		}
		if closeErr := reconciler.Close(); closeErr != nil {
			retain = true
			t.Errorf("EOF reconciler close: %v", closeErr)
		}
		if t.Failed() {
			retain = true
		}
		t.Logf("operational EOF cleanup: owned_absent=%t checked_reconciler_close=true evidence_retained=%t", absent, retain)
	})
	port := freeLoopbackPort(t)
	native := fmt.Sprintf(`{"log":{"loglevel":"none"},"inbounds":[{"tag":"entry","listen":"127.0.0.1","port":%d,"protocol":"vless","settings":{"decryption":"none","clients":[{"id":"00112233-4455-6677-8899-aabbccddeeff","email":"subject"}]},"streamSettings":{"network":"tcp","security":"none"}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]}`, port)
	policy := entrypolicy.Descriptor{SchemaVersion: 1, AdapterID: ManagedXrayID, RuntimeVersion: ManagedXrayVersion, CoreVersion: "26.3.27", DestinationPolicy: entrypolicy.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}, Bindings: []entrypolicy.Binding{{SubjectID: "subject", AccountID: "account", RouteID: "route", EntryID: "entry", InboundTag: "entry", CredentialVersion: "credential", PolicyRevision: "policy", CycleID: "cycle"}}}
	policyBytes, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	desired.Artifacts = []domain.Artifact{{Path: "config.json", Content: native}, {Path: "entry-policy.json", Content: string(policyBytes)}}
	desired.Digest, err = ArtifactDigest(desired.Artifacts)
	if err != nil {
		t.Fatal(err)
	}
	state, err := reconciler.Submit(context.Background(), desired)
	if err != nil || state.Phase != ObservedConformant {
		t.Fatalf("actual managed activation: phase=%s err=%v", state.Phase, err)
	}

	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	echoDone := make(chan struct{})
	go func() {
		defer close(echoDone)
		c, e := echo.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		io.Copy(c, c)
	}()
	client, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(3 * time.Second))
	uuid, _ := hex.DecodeString("00112233445566778899aabbccddeeff")
	target := echo.Addr().(*net.TCPAddr).Port
	header := append([]byte{0}, uuid...)
	header = append(header, 0, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
	payload := []byte("live-before-broker-EOF")
	if _, err = client.Write(append(header, payload...)); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, len(payload)+2)
	if _, err = io.ReadFull(client, response); err != nil || !bytes.Equal(response[:2], []byte{0, 0}) || !bytes.Equal(response[2:], payload) {
		t.Fatalf("authenticated native payload: %q %v", response, err)
	}
	snapshotContext, snapshotCancel := context.WithTimeout(context.Background(), 2*time.Second)
	snapshot, err := ReadManagedSnapshot(snapshotContext, root)
	snapshotCancel()
	if err != nil || snapshot.ActiveFlows != 1 || len(snapshot.Counters) != 1 || snapshot.Counters[0].CumulativeBytes != uint64(2*len(payload)) {
		t.Fatalf("live native snapshot: %+v %v", snapshot, err)
	}

	// No supervisor Stop/signal occurs until test cleanup. EOF alone must stop the
	// existing flow, close the listener, exit the child and finish its journal.
	began := time.Now()
	if err = broker.Close(); err != nil {
		t.Fatal(err)
	}
	var final entrypolicy.Snapshot
	deadline := time.Now().Add(3 * time.Second)
	for {
		observation, observeErr := supervisor.Observe(context.Background(), root)
		snapshots, journalErr := ReadManagedJournal(root)
		if observeErr == nil && observation.Known && observation.Identity.Generation == 0 && journalErr == nil {
			for _, s := range snapshots {
				if len(s.Counters) == 1 && s.CounterEpoch == snapshot.CounterEpoch && s.Counters[0].CumulativeBytes == snapshot.Counters[0].CumulativeBytes && s.ActiveFlows == 0 {
					final = s
				}
			}
			if !final.ObservedAt.IsZero() {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("broker EOF did not exit and persist final: observation=%+v error=%v journalError=%v", observation, observeErr, journalErr)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err = os.Stat(filepath.Join(ManagedJournalDirectory(root), "running.json")); !os.IsNotExist(err) {
		t.Fatalf("clean final left uncertainty marker: %v", err)
	}
	client.SetReadDeadline(time.Now().Add(time.Second))
	if n, err := client.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Fatalf("payload connection survived EOF: n=%d err=%v", n, err)
	}
	if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond); err == nil {
		conn.Close()
		t.Fatal("entry listener survived broker EOF")
	}
	select {
	case <-echoDone:
	case <-time.After(time.Second):
		t.Fatal("target flow did not close")
	}
	snapshots, err := ReadManagedJournal(root)
	if err != nil || len(snapshots) != 2 {
		t.Fatalf("expected genuine baseline and final: %d %v", len(snapshots), err)
	}
	var zeros int
	for _, s := range snapshots {
		if s.Counters[0].CumulativeBytes == 0 {
			zeros++
		}
	}
	if zeros != 1 || final.Counters[0].UploadBytes != uint64(len(payload)) || final.Counters[0].DownloadBytes != uint64(len(payload)) {
		t.Fatalf("baseline/final counter attribution incorrect: %+v", snapshots)
	}
	if os.Getenv("ROUTEWEAVER_OPERATIONAL_DRILL") == "1" {
		reopenStarted := time.Now()
		spoolPath := filepath.Join(root, "operations-spool")
		spool, openErr := OpenMeterSpool(spoolPath, desired.Scope, "operational-replay")
		if openErr != nil {
			t.Fatal(openErr)
		}
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			closeOperationalSpool(t, spool)
			t.Fatal(err)
		}
		pending := spool.Pending()
		if len(pending) != 2 || pending[0].Samples[0].CumulativeBytes != 0 || pending[1].Samples[0].CumulativeBytes != uint64(2*len(payload)) {
			closeOperationalSpool(t, spool)
			t.Fatal("real final journal lost exact baseline/final")
		}
		closeOperationalSpool(t, spool)
		spool, err = OpenMeterSpool(spoolPath, desired.Scope, "operational-replay")
		if err != nil {
			t.Fatal(err)
		}
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			closeOperationalSpool(t, spool)
			t.Fatal(err)
		}
		replay := spool.Pending()
		if len(replay) != 2 || replay[0].Digest != pending[0].Digest || replay[1].Digest != pending[1].Digest {
			closeOperationalSpool(t, spool)
			t.Fatal("reopen/recollect changed exact real-native meter batches")
		}
		// Synthetic matching receipts exercise the durable spool seam, not CP delivery.
		for _, batch := range replay {
			if err = spool.Ack(MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest}); err != nil {
				closeOperationalSpool(t, spool)
				t.Fatal(err)
			}
		}
		closeOperationalSpool(t, spool)
		spool, err = OpenMeterSpool(spoolPath, desired.Scope, "operational-replay")
		if err != nil {
			t.Fatal(err)
		}
		defer closeOperationalSpool(t, spool)
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil {
			t.Fatal(err)
		}
		terminal := spool.Pending()
		if len(terminal) != 1 || terminal[0].TerminalEvidence == nil || len(terminal[0].Samples) != 0 {
			t.Fatal("closed native proof needs distinct terminal custody")
		}
		proof := terminal[0].TerminalEvidence
		if proof.Validate() != nil || !reflect.DeepEqual(proof.Final, final) || proof.RuntimeEpoch != final.CounterEpoch || proof.Final.ActiveFlows != 0 || len(proof.Final.Counters) != 1 || proof.Final.Counters[0].CumulativeBytes != uint64(2*len(payload)) {
			t.Fatal("terminal custody changed genuine native final")
		}
		batch := terminal[0]
		// This is deliberately synthetic typed custody, not a CP-delivery assertion.
		if err = spool.Ack(MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest, CustodyVersion: entrypolicy.TerminalCustodyVersion, TerminalEvidenceDigest: proof.Digest}); err != nil {
			t.Fatal(err)
		}
		if err = CollectManagedCounters(context.Background(), root, spool, false); err != nil || len(spool.Pending()) != 0 {
			t.Fatal("typed custody did not retire exact native journal", err)
		}
		if remaining, err := ReadManagedJournal(root); err != nil || len(remaining) != 0 {
			t.Fatal("custodied journals not retired", err)
		}

		t.Logf("operational real-native journal: exact %d bytes retained across spool reopen/replay; synthetic typed custody permits journal GC; not CP delivery; recovery=%s", 2*len(payload), time.Since(reopenStarted))
	}
	t.Logf("broker EOF stopped live payload and owned process, preserved %d-byte final in %s", final.Counters[0].CumulativeBytes, time.Since(began))
}

func closeOperationalSpool(t *testing.T, spool *MeterSpool) {
	t.Helper()
	if err := spool.Close(); err != nil {
		t.Errorf("operational replay spool close: %v", err)
	}
}
