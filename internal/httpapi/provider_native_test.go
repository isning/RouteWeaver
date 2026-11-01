package httpapi_test

import (
	"context"
	"net"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestNativeManagedProviderSuspensionAndRecovery(t *testing.T) {
	testNativeContinuousManagedService(t, false, true)
}

func runNativeProviderSuspension(t *testing.T, f fleetFixture, conn net.Conn, d controlprotocol.Desired, user string, supervisor *agent.ProcessSupervisor, root string, dial func() (net.Conn, error)) net.Conn {
	t.Helper()
	now := time.Now().UTC()
	cfg := observability.Config{BilledInterfaces: []string{}, Provider: &observability.ProviderConfig{Name: "Synthetic provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "provider-native-cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "advisory"}}
	configure := func() {
		t.Helper()
		next, err := f.s.ConfigureNodeObservations(d.NodeID, cfg)
		if err != nil {
			t.Fatal(err)
		}
		cfg = next.Config
	}
	statement := func(used int64, at time.Time) {
		t.Helper()
		_, err := f.s.RecordNodeProviderStatement(d.NodeID, observability.StatementInput{CycleID: cfg.Provider.CycleID, UsedBytes: used, ObservedAt: at, Reference: "synthetic native acceptance statement"}, "operator", time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
	}
	configure()
	statement(10, time.Now().UTC())
	cfg.Provider.ExhaustionAction = "suspend-managed"
	configure()
	expected := uint64(2 * (len("before-renewal") + len("after-original-instance-lease")))
	awaitClosed := func(c net.Conn, within time.Duration) time.Duration {
		t.Helper()
		started := time.Now()
		c.SetReadDeadline(started.Add(within))
		var b [1]byte
		n, err := c.Read(b[:])
		if err == nil || n != 0 {
			t.Fatal("paused connection remained readable", n, err)
		}
		if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("provider pause did not close active flow", err)
		}
		c.Close()
		return time.Since(started)
	}
	settled := func() {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			snapshot, err := agent.ReadManagedSnapshot(context.Background(), root)
			if err != nil {
				t.Fatal(err)
			}
			var raw uint64
			for _, counter := range snapshot.Counters {
				raw += counter.CumulativeBytes
			}
			usage, err := f.s.Usage(user, time.Time{}, time.Time{})
			if err != nil {
				t.Fatal(err)
			}
			reviews, err := f.s.AdmissionBudgetReviews(d.InstanceID, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			allClosed := len(reviews) > 0
			var settledRaw uint64
			for _, review := range reviews {
				allClosed = allClosed && review.Closed && !review.Unresolved
				settledRaw += review.SettledRaw
			}
			if snapshot.ActiveFlows == 0 && raw == expected && usage.RawBytes == int64(expected) && usage.WeightedBytes == int64(expected) && allClosed && settledRaw == expected {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("provider final obligations mismatch: expected=%d native=%d active=%d usage=%+v allClosed=%v settled=%d", expected, raw, snapshot.ActiveFlows, usage, allClosed, settledRaw)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	statement(1000000000, time.Now().UTC())
	exhaustedClose := awaitClosed(conn, entrypolicy.MaxLease+3*time.Second)
	if denied, err := dial(); err == nil {
		denied.Close()
		t.Fatal("exhausted provider admitted new native flow")
	}
	settled()
	statement(11, time.Now().UTC())
	recovered, err := dial()
	if err != nil {
		t.Fatal("fresh provider evidence did not recover native flow", err)
	}
	expected += uint64(2 * len("before-renewal"))
	statement(1000000000, time.Now().UTC())
	awaitClosed(recovered, entrypolicy.MaxLease+3*time.Second)
	settled()
	// A new explicit cycle permits an older but still fresh independent statement.
	// This tests the evidence expiry ceiling with real time, not a fake clock.
	cfg.Provider.ExhaustionAction = "advisory"
	cfg.Provider.CycleID = "provider-native-next-cycle"
	configure()
	at := time.Now().UTC().Add(-observability.FreshFor + 4*time.Second)
	statement(12, at)
	cfg.Provider.ExhaustionAction = "suspend-managed"
	configure()
	clipped, err := dial()
	if err != nil {
		t.Fatal("near-expiry fresh statement did not admit", err)
	}
	expected += uint64(2 * len("before-renewal"))
	status, err := f.s.AdmissionStatus(user, time.Now())
	if err != nil || status.ActiveStreams != 1 {
		t.Fatal("missing clipped live reservation", status, err)
	}
	for _, entry := range status.Entries {
		if entry.LatestExpiry.After(at.Add(observability.FreshFor)) {
			t.Fatal("native admission outlived statement freshness", entry.LatestExpiry)
		}
	}
	freshnessClose := awaitClosed(clipped, 7*time.Second)
	settled()
	if denied, err := dial(); err == nil {
		denied.Close()
		t.Fatal("stale provider statement admitted new native flow")
	}
	statement(13, time.Now().UTC())
	final, err := dial()
	if err != nil {
		t.Fatal("provider recovery failed", err)
	}
	observed, err := supervisor.Observe(context.Background(), root)
	if err != nil || observed.Identity != d.Identity() {
		final.Close()
		t.Fatal("provider policy silently replaced native runtime", err)
	}
	// Existing caller still executes mandatory real credential revocation/closure.
	t.Logf("provider native: exhausted closure=%s freshness-clipped closure=%s exact finalized raw/weighted=%d bytes; all corresponding budget obligations closed, no route/core identity change", exhaustedClose, freshnessClose, expected)
	return final
}
