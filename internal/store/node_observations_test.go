package store_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestNodeObservationsPersistAndDesignateOneCorePerPhysicalNode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.db")
	key := bytes.Repeat([]byte{7}, 32)
	db, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	for kind, v := range map[string]any{"hosts": domain.Host{ID: "node", Name: "Node", Address: "127.0.0.1"}, "core-instances": domain.CoreInstance{ID: "core", HostID: "node"}} {
		id := "node"
		if kind == "core-instances" {
			id = "core"
		}
		if e = db.Put(kind, id, v); e != nil {
			t.Fatal(e)
		}
	}
	scope := controlprotocol.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enr"}
	if e = db.Put("instance-enrollments", "core", map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	c := observability.Config{ObserverInstanceID: "core", BilledInterfaces: []string{"eth0"}}
	if _, e = db.ConfigureNodeObservations("node", c); e != nil {
		t.Fatal(e)
	}
	r := observability.Report{Scope: observability.Scope(scope), StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, CPUIdleTicks: 60, MemoryTotalBytes: 1000, MemoryAvailableBytes: 500, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 100, TransmitBytes: 200}}}}
	r.Digest = observability.ReportDigest(r)
	if _, e = db.AcceptNodeObservation(r, now); e != nil {
		t.Fatal(e)
	}
	if receipt, e := db.AcceptNodeObservation(r, now); e != nil || !receipt.Duplicate {
		t.Fatalf("exact retry %+v %v", receipt, e)
	}
	r.Scope.InstanceID = "other"
	r.Digest = observability.ReportDigest(r)
	if _, e = db.AcceptNodeObservation(r, now); e == nil {
		t.Fatal("second core reported same physical node")
	}
	history, e := db.NodeResourceHistory(context.Background(), "node", now)
	if e != nil || !history.Available || len(history.Points) != 1 || history.Points[0].CPUPercent != nil {
		t.Fatalf("history retry/scope protection: %+v %v", history, e)
	}
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	db, e = store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	state, e := db.NodeObservations("node")
	if e != nil || state.Latest == nil || state.Latest.Sequence != 1 || state.Config.Revision != 1 {
		t.Fatalf("snapshot/config lost after reopen: %+v %v", state, e)
	}
	history, e = db.NodeResourceHistory(context.Background(), "node", now)
	if e != nil || len(history.Points) != 1 {
		t.Fatal("history not persisted", e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = db.NodeResourceHistory(ctx, "node", now); !errors.Is(e, context.Canceled) {
		t.Fatal("ignored cancellation", e)
	}
	if e = db.PruneNodeResourceHistories(context.Background(), now.Add(25*time.Hour)); e != nil {
		t.Fatal(e)
	}
	history, e = db.NodeResourceHistory(context.Background(), "node", now.Add(25*time.Hour))
	if e != nil || len(history.Points) != 0 {
		t.Fatal("retained expired history", e)
	}
}

func TestNodeObservationWritesSerializeAcrossStoreHandles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared-node.db")
	key := bytes.Repeat([]byte{8}, 32)
	a, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	now := time.Now().UTC()
	scope := observability.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enr"}
	for _, v := range []struct {
		kind, id string
		value    any
	}{{"hosts", "node", domain.Host{ID: "node", Name: "Node", Address: "127.0.0.1"}}, {"core-instances", "core", domain.CoreInstance{ID: "core", HostID: "node"}}, {"instance-enrollments", "core", map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour)}}} {
		if e = a.Put(v.kind, v.id, v.value); e != nil {
			t.Fatal(e)
		}
	}
	config := observability.Config{ObserverInstanceID: "core", BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "TB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "nic_estimate", ExhaustionAction: "advisory"}}
	parallel := func(one, two func() error) (error, error) {
		t.Helper()
		start := make(chan struct{})
		result := make(chan error, 2)
		go func() { <-start; result <- one() }()
		go func() { <-start; result <- two() }()
		close(start)
		return <-result, <-result
	}
	for round := 0; round < 10; round++ {
		config.Revision = uint64(round)
		x, y := parallel(func() error { _, e := a.ConfigureNodeObservations("node", config); return e }, func() error { _, e := b.ConfigureNodeObservations("node", config); return e })
		if (x == nil) == (y == nil) {
			t.Fatalf("two writers accepted same configuration revision or both failed: %v / %v", x, y)
		}
		if x != nil && !errors.Is(x, observability.ErrConflict) || y != nil && !errors.Is(y, observability.ErrConflict) {
			t.Fatalf("configuration race failed outside revision fence: %v / %v", x, y)
		}
	}
	report := observability.Report{Scope: scope, StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, MemoryTotalBytes: 1000, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000}}}}
	report.Digest = observability.ReportDigest(report)
	if _, e = a.AcceptNodeObservation(report, now); e != nil {
		t.Fatal(e)
	}
	for round := 0; round < 10; round++ {
		report.Sequence++
		report.ObservedAt = report.ObservedAt.Add(time.Second)
		report.Metrics.Interfaces[0].ReceiveBytes += 100
		report.Metrics.Interfaces[0].TransmitBytes += 200
		report.Digest = observability.ReportDigest(report)
		duplicates := make(chan bool, 2)
		send := func(db *store.Store) func() error {
			return func() error {
				receipt, e := db.AcceptNodeObservation(report, report.ObservedAt)
				duplicates <- receipt.Duplicate
				return e
			}
		}
		x, y := parallel(send(a), send(b))
		if x != nil || y != nil {
			t.Fatalf("concurrent exact retry failed: %v / %v", x, y)
		}
		if d1, d2 := <-duplicates, <-duplicates; d1 == d2 {
			t.Fatal("concurrent duplicate counted as two new samples")
		}
		baseline := observability.BaselineInput{CycleID: "cycle", UsedBytes: int64(100 + round), ReportDigest: report.Digest, Reason: fmt.Sprintf("baseline-%d", round)}
		statement := observability.StatementInput{CycleID: "cycle", UsedBytes: int64(900 + round), ObservedAt: report.ObservedAt, Reference: fmt.Sprintf("statement-%d", round)}
		x, y = parallel(func() error {
			_, e := a.ReconcileNodeProvider("node", baseline, "operator", report.ObservedAt)
			return e
		}, func() error {
			_, e := b.RecordNodeProviderStatement("node", statement, "operator", report.ObservedAt)
			return e
		})
		if x != nil || y != nil {
			t.Fatalf("unrelated baseline/statement writes failed: %v / %v", x, y)
		}
		state, e := a.NodeObservations("node")
		if e != nil || state.Baseline == nil || state.Statement == nil || state.Baseline.Reason != baseline.Reason || state.Statement.Reference != statement.Reference || state.ObservedNICBytes != int64((round+1)*300) {
			t.Fatalf("cross-handle write lost a field or doubled NIC bytes: %+v %v", state, e)
		}
	}
	// A different handle's enrollment revocation is part of the ingestion fence.
	if e = b.Put("instance-enrollments", "core", map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour), "revoked": true}); e != nil {
		t.Fatal(e)
	}
	if _, e = a.AcceptNodeObservation(report, report.ObservedAt); !errors.Is(e, observability.ErrScope) {
		t.Fatalf("cross-handle revoked enrollment accepted: %v", e)
	}
}
