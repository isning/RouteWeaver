package observability_test

import (
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestProviderSuspensionRequiresFreshExplicitUsageAndRecovers(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	s := observability.State{Config: observability.Config{Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "suspend-managed"}}}
	if err := observability.ValidateConfig(s.Config); err != nil {
		t.Fatal(err)
	}
	check := func(want string) {
		t.Helper()
		reason, _ := observability.ManagedAdmission(s, now)
		if reason != want {
			t.Fatalf("reason=%q want=%q", reason, want)
		}
	}
	check("provider-usage-unknown")
	s.Statement = &observability.Statement{StatementInput: observability.StatementInput{CycleID: "cycle", UsedBytes: 1000000000, ObservedAt: now}}
	check("provider-exhausted")
	s.Statement.UsedBytes = 10
	check("")
	_, until := observability.ManagedAdmission(s, now)
	if until == nil || !until.Equal(now.Add(observability.FreshFor)) {
		t.Fatal("lease not bounded by evidence freshness", until)
	}
	s.Statement.ObservedAt = now.Add(-observability.FreshFor - time.Second)
	check("provider-usage-unknown")
	s.Config.Provider.ExhaustionAction = "advisory"
	check("")
	s.Config.Provider.ExhaustionAction = "suspend-managed"
	s.Config.Provider.NotificationSource = "none"
	if observability.ValidateConfig(s.Config) == nil {
		t.Fatal("suspension accepted without explicit evidence source")
	}
}

func TestProviderSuspensionEvidenceBoundaries(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, source string
		change       func(*observability.State)
		want         string
	}{
		{"current statement", "provider_statement", func(s *observability.State) {}, ""},
		{"wrong statement cycle", "provider_statement", func(s *observability.State) { s.Statement.CycleID = "old" }, "provider-usage-unknown"},
		{"expired cycle", "provider_statement", func(s *observability.State) { s.Config.Provider.CycleEnd = now }, "provider-usage-unknown"},
		{"expired service", "provider_statement", func(s *observability.State) { s.Config.Provider.ExpiresAt = &now }, "provider-expired"},
		{"uncorrected NIC partial", "nic_estimate", func(s *observability.State) { s.Baseline = nil }, "provider-usage-unknown"},
		{"reconciled NIC estimate", "nic_estimate", func(s *observability.State) {}, ""},
		{"NIC exhausted", "nic_estimate", func(s *observability.State) { s.ObservedNICBytes = 1000000000 }, "provider-exhausted"},
		{"selected source has no fallback", "provider_statement", func(s *observability.State) { s.Statement = nil }, "provider-usage-unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := observability.State{Config: observability.Config{BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: tc.source, ExhaustionAction: "suspend-managed"}}, Statement: &observability.Statement{StatementInput: observability.StatementInput{CycleID: "cycle", UsedBytes: 1, ObservedAt: now}}, Latest: &observability.Snapshot{Report: observability.Report{ObservedAt: now}}, Baseline: &observability.Baseline{BaselineInput: observability.BaselineInput{CycleID: "cycle", UsedBytes: 1}}, ObservedNICBytes: 10}
			tc.change(&s)
			got, _ := observability.ManagedAdmission(s, now)
			if got != tc.want {
				t.Fatalf("got=%q want=%q", got, tc.want)
			}
			view := observability.ViewOf("node", s, now)
			if view.Provider.ManagedAdmissionReason != got || view.Provider.ExhaustionAction != "suspend-managed" {
				t.Fatalf("operator view disagrees: %+v", view.Provider)
			}
		})
	}
}
