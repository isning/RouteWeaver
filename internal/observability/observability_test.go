package observability_test

import (
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestInitialObservationNeverInventsCPUOrProviderConsumption(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	s := observability.State{Config: observability.Config{ObserverInstanceID: "core", BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "UK ISP", Mode: "limited", Allowance: 2, Unit: "TB", CycleID: "operator-cycle", CycleStart: now.Add(-24 * time.Hour), CycleEnd: now.Add(24 * time.Hour), NotificationSource: "nic_estimate", ExhaustionAction: "advisory"}}}
	report := observability.Report{Scope: observability.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enrollment"}, StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, CPUIdleTicks: 50, MemoryTotalBytes: 1000, MemoryAvailableBytes: 500, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 9000, TransmitBytes: 1000}, {Name: "lo", ReceiveBytes: 900000, TransmitBytes: 900000}}}}
	report.Digest = observability.ReportDigest(report)
	next, receipt, err := observability.Accept(s, report, now)
	if err != nil || receipt.Sequence != 1 {
		t.Fatalf("accept: %+v %v", receipt, err)
	}
	view := observability.ViewOf("node", next, now)
	if view.Latest.CPUPercent != nil || view.Provider.UsedBytes != nil || view.Provider.RemainingBytes != nil || view.Provider.ObservedNICBytes != 0 {
		t.Fatalf("invented initial completeness: %+v", view)
	}
	if view.Provider.TotalBytes == nil || *view.Provider.TotalBytes != 2000000000000 {
		t.Fatalf("TB must be decimal: %+v", view.Provider)
	}
}

func fixture(t *testing.T) (observability.State, observability.Report, time.Time) {
	t.Helper()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	s := observability.State{Config: observability.Config{ObserverInstanceID: "core", BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "FRA CN2", Mode: "limited", Allowance: 800, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "nic_estimate", ExhaustionAction: "advisory"}}}
	r := observability.Report{Scope: observability.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enr"}, StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, CPUIdleTicks: 50, MemoryTotalBytes: 1000, MemoryAvailableBytes: 500, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000}, {Name: "lo", ReceiveBytes: 1000000, TransmitBytes: 1000000}, {Name: "veth0", ReceiveBytes: 99999, TransmitBytes: 99999}}}}
	r.Digest = observability.ReportDigest(r)
	next, _, e := observability.Accept(s, r, now)
	if e != nil {
		t.Fatal(e)
	}
	return next, r, now
}
func advance(r observability.Report) observability.Report {
	r.Sequence++
	r.ObservedAt = r.ObservedAt.Add(time.Minute)
	r.Metrics.CPUTotalTicks += 100
	r.Metrics.CPUIdleTicks += 25
	r.Metrics.Interfaces = append([]observability.Interface(nil), r.Metrics.Interfaces...)
	r.Metrics.Interfaces[0].ReceiveBytes += 100
	r.Metrics.Interfaces[0].TransmitBytes += 200
	r.Metrics.Interfaces[1].ReceiveBytes += 1000000
	r.Digest = observability.ReportDigest(r)
	return r
}
func TestProviderEstimateRequiresOperatorBaselineAndCountsSelectedINPlusOUTOnly(t *testing.T) {
	s, r, now := fixture(t)
	r = advance(r)
	s, _, _ = observability.Accept(s, r, r.ObservedAt)
	v := observability.ViewOf("node", s, r.ObservedAt)
	if v.Latest.CPUPercent == nil || *v.Latest.CPUPercent != 75 || v.Provider.ObservedNICBytes != 300 || v.Provider.RemainingBytes != nil || v.Provider.NotificationEligible {
		t.Fatalf("partial estimate: %+v", v)
	}
	if v.Latest.ReceiveBytesPerSecond == nil || *v.Latest.ReceiveBytesPerSecond != 100.0/60 {
		t.Fatalf("wrong selected NIC rate %+v", v.Latest)
	}
	var e error
	s, e = observability.Reconcile(s, observability.BaselineInput{CycleID: "cycle", UsedBytes: 790000000000, ReportDigest: r.Digest, Reason: "provider statement reconciled to current NIC sample"}, "operator", r.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	r = advance(r)
	s, _, e = observability.Accept(s, r, r.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	v = observability.ViewOf("node", s, r.ObservedAt)
	if v.Provider.UsedBytes == nil || *v.Provider.UsedBytes != 790000000300 || *v.Provider.RemainingBytes != 9999999700 || !v.Provider.NotificationEligible || v.Provider.Coverage != "reconciled_estimate" {
		t.Fatalf("baseline estimate %+v", v.Provider)
	}
	stale := observability.ViewOf("node", s, now.Add(20*time.Minute))
	if stale.Provider.Fresh || stale.Provider.NotificationEligible {
		t.Fatal("old snapshot alerted as current")
	}
}
func TestReplayConflictGapResetAndCycleCrossingCannotFabricateCoverage(t *testing.T) {
	s, r, now := fixture(t)
	duplicate, receipt, e := observability.Accept(s, r, now)
	if e != nil || !receipt.Duplicate || duplicate.ObservedNICBytes != 0 {
		t.Fatalf("duplicate %+v %v", receipt, e)
	}
	corrupt := r
	corrupt.Metrics.MemoryAvailableBytes = 400
	corrupt.Digest = observability.ReportDigest(corrupt)
	if _, _, e = observability.Accept(s, corrupt, now); e == nil {
		t.Fatal("conflicting duplicate accepted")
	}
	for _, tc := range []struct {
		name       string
		mutate     func(*observability.Report)
		continuity string
	}{
		{"sequence gap", func(r *observability.Report) { r.Sequence++ }, "sequence_gap"},
		{"boot reset", func(r *observability.Report) { r.Metrics.CounterEpoch = "boot2" }, "counter_reset"},
		{"NIC reset", func(r *observability.Report) { r.Metrics.Interfaces[0].ReceiveBytes = 1 }, "interface_gap"},
		{"missing NIC", func(r *observability.Report) { r.Metrics.Interfaces = r.Metrics.Interfaces[1:] }, "interface_gap"},
		{"stream restart", func(r *observability.Report) { r.StreamEpoch = "stream2"; r.Sequence = 1 }, "stream_reset"},
		{"time gap", func(r *observability.Report) { r.ObservedAt = r.ObservedAt.Add(20 * time.Minute) }, "time_gap"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy, e := observability.Reconcile(s, observability.BaselineInput{CycleID: "cycle", UsedBytes: 30, ReportDigest: r.Digest, Reason: "reconcile"}, "operator", now)
			if e != nil {
				t.Fatal(e)
			}
			next := advance(r)
			tc.mutate(&next)
			next.Digest = observability.ReportDigest(next)
			copy, _, e = observability.Accept(copy, next, next.ObservedAt)
			if e != nil {
				t.Fatal(e)
			}
			v := observability.ViewOf("node", copy, next.ObservedAt)
			if v.Latest.Continuity != tc.continuity || v.Provider.UsedBytes != nil || v.Provider.NotificationEligible || copy.Baseline != nil {
				t.Fatalf("gap promoted to complete %+v", v)
			}
		})
	}
	next := advance(r)
	next.ObservedAt = s.Config.Provider.CycleEnd
	next.Digest = observability.ReportDigest(next)
	after, _, e := observability.Accept(s, next, next.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	if after.ObservedNICBytes != 0 || observability.ViewOf("node", after, next.ObservedAt).Provider.NotificationEligible {
		t.Fatal("cycle crossing interpolated into usage")
	}
}
func TestProviderStatementIsIndependentOfNICAndOldOrFutureInputsCannotAlert(t *testing.T) {
	s, _, now := fixture(t)
	s.Config.Provider.NotificationSource = "provider_statement"
	s, e := observability.RecordStatement(s, observability.StatementInput{CycleID: "cycle", UsedBytes: 795000000000, ObservedAt: now, Reference: "operator copied provider portal statement"}, "operator", now)
	if e != nil {
		t.Fatal(e)
	}
	v := observability.ViewOf("node", s, now)
	if !v.Provider.NotificationEligible || v.Provider.Source != "provider_statement" || *v.Provider.RemainingBytes != 5000000000 || v.Provider.ObservedNICBytes != 0 {
		t.Fatalf("statement %+v", v.Provider)
	}
	if _, e = observability.RecordStatement(s, observability.StatementInput{CycleID: "cycle", UsedBytes: 0, ObservedAt: now.Add(10 * time.Minute), Reference: "future"}, "operator", now); e == nil {
		t.Fatal("future statement accepted")
	}
	s.Config.Provider.NotificationSource = "none"
	if observability.ViewOf("node", s, now).Provider.NotificationEligible {
		t.Fatal("disabled notification source ignored")
	}
	s.Config.Provider.Mode = "unlimited"
	s.Config.Provider.Allowance = 0
	v = observability.ViewOf("node", s, now)
	if v.Provider.TotalBytes != nil || v.Provider.RemainingBytes != nil || v.Provider.NotificationEligible {
		t.Fatal("unlimited invented finite remaining")
	}
}
func TestConfigRequiresLabeledUnitsCycleAndExplicitProviderInterfaces(t *testing.T) {
	s, _, _ := fixture(t)
	for _, unit := range []struct {
		name string
		want int64
	}{{"GB", 1000000000}, {"TB", 1000000000000}, {"GiB", 1073741824}, {"TiB", 1099511627776}} {
		p := *s.Config.Provider
		p.Allowance = 1
		p.Unit = unit.name
		got, e := observability.TotalBytes(p)
		if e != nil || got != unit.want {
			t.Fatalf("%s: %d %v", unit.name, got, e)
		}
	}
	for _, nic := range []string{"lo", "veth0", "docker0", "br-fake", "eth0/../x"} {
		c := s.Config
		c.BilledInterfaces = []string{nic}
		if observability.ValidateConfig(c) == nil {
			t.Fatalf("non-provider interface %s accepted", nic)
		}
	}
	c := s.Config
	p := *c.Provider
	c.Provider = &p
	p.Unit = "G"
	if observability.ValidateConfig(c) == nil {
		t.Fatal("ambiguous G accepted")
	}
	p.Unit = "GB"
	p.CycleStart = time.Time{}
	if observability.ValidateConfig(c) == nil {
		t.Fatal("invented provider cycle start")
	}
	c = s.Config
	c.Revision = 2
	if _, e := observability.Configure(s, c); e == nil {
		t.Fatal("stale configuration overwrote new state")
	}
}
func TestCycleBoundaryAndBaselineRaceStayExplicit(t *testing.T) {
	s, r, now := fixture(t)
	s.Config.Provider.CycleEnd = now.Add(30 * time.Second)
	next := advance(r)
	after, _, e := observability.Accept(s, next, next.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	if after.CoverageReason != "cycle_boundary_requires_reconciliation" || after.ObservedNICBytes != 0 {
		t.Fatalf("fabricated cycle split: %+v", after)
	}
	s, r, now = fixture(t)
	next = advance(r)
	s, _, e = observability.Accept(s, next, next.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = observability.Reconcile(s, observability.BaselineInput{CycleID: "cycle", UsedBytes: 100, ReportDigest: r.Digest, Reason: "outdated dialog"}, "operator", next.ObservedAt); e == nil {
		t.Fatal("stale baseline silently attached to newer NIC sample")
	}
	if _, _, e = observability.Accept(s, r, now); e == nil {
		t.Fatal("old sequence accepted after newer snapshot")
	}
}
func TestUnlimitedProviderDoesNotRequireInventedResetCycle(t *testing.T) {
	s, r, now := fixture(t)
	config := s.Config
	config.Provider = &observability.ProviderConfig{Name: "Unlimited provider", Mode: "unlimited", NotificationSource: "none", ExhaustionAction: "advisory"}
	if e := observability.ValidateConfig(config); e != nil {
		t.Fatalf("unlimited provider forced to invent reset date: %v", e)
	}
	s, e := observability.Configure(s, config)
	if e != nil {
		t.Fatal(e)
	}
	next := advance(r)
	s, _, e = observability.Accept(s, next, next.ObservedAt)
	if e != nil {
		t.Fatal(e)
	}
	view := observability.ViewOf("node", s, now)
	if view.Provider.TotalBytes != nil || view.Provider.RemainingBytes != nil || view.Provider.NotificationEligible || view.Provider.ObservedNICBytes != 300 {
		t.Fatalf("unlimited observation invented a quota or reset: %+v", view.Provider)
	}
}
