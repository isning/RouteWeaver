package store_test

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestNodeHistoryCapacityCleanupAndConfigurationIsolation(t *testing.T) {
	db, e := store.Open(filepath.Join(t.TempDir(), "node.db"), bytes.Repeat([]byte{8}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	now := time.Now().UTC()
	for i := 0; i < 256; i++ {
		id := fmt.Sprintf("node-%d", i)
		if e = db.Put("node-resource-history", id, observability.ResourceHistory{Points: []observability.ResourcePoint{{ObservedAt: now.Add(-25 * time.Hour), MemoryUsedPercent: 50}}}); e != nil {
			t.Fatal(e)
		}
	}
	if e = db.Put("hosts", "node", domain.Host{ID: "node", Name: "Node"}); e != nil {
		t.Fatal(e)
	}
	v, e := db.NodeResourceHistory(context.Background(), "node", now)
	if e != nil || v.Available || v.Reason != "capacity" {
		t.Fatalf("capacity falsely empty %+v %v", v, e)
	}
	if e = db.PruneNodeResourceHistories(context.Background(), now); e != nil {
		t.Fatal(e)
	}
	v, e = db.NodeResourceHistory(context.Background(), "node", now)
	if e != nil || !v.Available || len(v.Points) != 0 {
		t.Fatalf("cleanup did not free capacity %+v %v", v, e)
	}
	if e = db.Put("node-resource-history", "node", observability.ResourceHistory{Points: []observability.ResourcePoint{{ObservedAt: now, MemoryUsedPercent: 50}}}); e != nil {
		t.Fatal(e)
	}
	if _, e = db.ConfigureNodeObservations("node", observability.Config{BilledInterfaces: []string{"eth0"}}); e != nil {
		t.Fatal(e)
	}
	v, e = db.NodeResourceHistory(context.Background(), "node", now)
	if e != nil || len(v.Points) != 0 {
		t.Fatal("mixed differently configured interfaces", e)
	}
	if e = db.Put("node-resource-history", "node", map[string]any{"points": make([]observability.ResourcePoint, 289)}); e != nil {
		t.Fatal(e)
	}
	if _, e = db.NodeResourceHistory(context.Background(), "node", now); e == nil {
		t.Fatal("oversized history silently truncated")
	}
}

func TestDamagedResourceHistoryDoesNotBlockObservationsOrOtherCleanup(t *testing.T) {
	db, e := store.Open(filepath.Join(t.TempDir(), "node.db"), bytes.Repeat([]byte{9}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	now := time.Now().UTC()
	if e = db.Put("hosts", "node", domain.Host{ID: "node", Name: "Node"}); e != nil {
		t.Fatal(e)
	}
	if e = db.Put("core-instances", "core", domain.CoreInstance{ID: "core", HostID: "node"}); e != nil {
		t.Fatal(e)
	}
	scope := observability.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enr"}
	if e = db.Put("instance-enrollments", "core", map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	if _, e = db.ConfigureNodeObservations("node", observability.Config{ObserverInstanceID: "core", BilledInterfaces: []string{"eth0"}}); e != nil {
		t.Fatal(e)
	}
	if e = db.Put("node-resource-history", "node", map[string]any{"points": make([]observability.ResourcePoint, 289)}); e != nil {
		t.Fatal(e)
	}
	r := observability.Report{Scope: scope, StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, CPUIdleTicks: 60, MemoryTotalBytes: 100, MemoryAvailableBytes: 50}}
	r.Digest = observability.ReportDigest(r)
	if _, e = db.AcceptNodeObservation(r, now); e != nil {
		t.Fatal("optional history blocked latest observation", e)
	}
	state, e := db.NodeObservations("node")
	if e != nil || state.Latest == nil || state.Latest.Sequence != 1 {
		t.Fatal("latest observation lost", e)
	}
	if _, e = db.NodeResourceHistory(context.Background(), "node", now); e == nil {
		t.Fatal("damaged history appeared available")
	}
	if e = db.Put("node-resource-history", "zzexpired", observability.ResourceHistory{Points: []observability.ResourcePoint{{ObservedAt: now.Add(-25 * time.Hour), MemoryUsedPercent: 1}}}); e != nil {
		t.Fatal(e)
	}
	if e = db.PruneNodeResourceHistories(context.Background(), now); e == nil {
		t.Fatal("did not report damaged history")
	}
	var expired observability.ResourceHistory
	if e = db.Get("node-resource-history", "zzexpired", &expired); e != store.ErrNotFound {
		t.Fatal("one bad history blocked other cleanup", e)
	}
}

func TestNodeHistoryWindowsAndLegacyCompatibility(t *testing.T) {
	db, e := store.Open(filepath.Join(t.TempDir(), "windows.db"), bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	now := time.Now().UTC()
	if e = db.Put("hosts", "node", domain.Host{ID: "node", Name: "Node"}); e != nil {
		t.Fatal(e)
	}
	h := observability.ResourceHistory{}
	for i := 287; i >= 0; i-- {
		h.Points = append(h.Points, observability.ResourcePoint{ObservedAt: now.Add(-time.Duration(i) * 5 * time.Minute), MemoryUsedPercent: 50})
	}
	if e = db.Put("node-resource-history", "node", h); e != nil {
		t.Fatal(e)
	}
	v, e := db.NodeResourceHistory(context.Background(), "node", now, "7d")
	if e != nil || len(v.Points) != 0 {
		t.Fatal("legacy data fabricated hourly history", e)
	}
	for i := 167; i >= 0; i-- {
		h.Hourly = append(h.Hourly, observability.ResourcePoint{ObservedAt: now.Add(-time.Duration(i) * time.Hour), MemoryUsedPercent: 50})
	}
	if e = db.Put("node-resource-history", "node", h); e != nil {
		t.Fatal(e)
	}
	if e = db.Put("node-resource-hourly", "node", observability.ResourceHistory{Hourly: h.Hourly}); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		window          string
		count, interval int
	}{{"1h", 12, 300}, {"24h", 288, 300}, {"7d", 168, 3600}} {
		v, e = db.NodeResourceHistory(context.Background(), "node", now, tc.window)
		if e != nil || len(v.Points) != tc.count || v.IntervalSeconds != tc.interval {
			t.Fatalf("window %s %+v %v", tc.window, v, e)
		}
	}
	if e = db.PruneNodeResourceHistories(context.Background(), now.Add(25*time.Hour)); e != nil {
		t.Fatal(e)
	}
	v, e = db.NodeResourceHistory(context.Background(), "node", now.Add(25*time.Hour), "7d")
	if e != nil || len(v.Points) == 0 {
		t.Fatal("daily cleanup removed weekly data", e)
	}
	if _, e = db.NodeResourceHistory(context.Background(), "node", now, "forever"); e == nil {
		t.Fatal("unbounded window accepted")
	}
}
