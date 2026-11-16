package httpapi_test

import (
	"math"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/observability"
	"strings"
	"testing"
	"time"
)

func attributedProviderState(source string, now time.Time) observability.State {
	return observability.State{Config: observability.Config{BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: source, ExhaustionAction: "suspend-managed"}}, Statement: &observability.Statement{StatementInput: observability.StatementInput{CycleID: "cycle", UsedBytes: 10, ObservedAt: now}}, Latest: &observability.Snapshot{Report: observability.Report{ObservedAt: now}}, Baseline: &observability.Baseline{BaselineInput: observability.BaselineInput{CycleID: "cycle", UsedBytes: 10}, NICBytesAtBaseline: 0}, ObservedNICBytes: 10}
}

func TestActionsAttributedProviderEvidence(t *testing.T) {
	f := newActionsAttributedFixture(t)
	var published httpapi.Output
	if e := f.s.TenantGet(f.owner.id, "outputs", "isolated", &published); e != nil {
		t.Fatal(e)
	}
	check := func(t *testing.T, changed, unchecked bool) {
		t.Helper()
		code, v, raw := req(t, f.owner.c, "GET", f.srv.URL+"/api/me/actions", "", nil)
		if code != 200 {
			t.Fatal(raw)
		}
		found := false
		for _, x := range v["items"].([]any) {
			i := x.(map[string]any)
			if i["id"] == "output:isolated" && i["kind"] == "output-changed" {
				found = true
			}
		}
		deferred := false
		for _, x := range v["uncheckedOutputs"].([]any) {
			if x.(map[string]any)["id"] == "isolated" {
				deferred = true
			}
		}
		if found != changed || deferred != unchecked {
			t.Fatal(raw)
		}
		var after httpapi.Output
		if e := f.s.TenantGet(f.owner.id, "outputs", "isolated", &after); e != nil || !reflect.DeepEqual(after, published) {
			t.Fatal("publication mutated", e)
		}
	}
	put := func(t *testing.T, s observability.State) {
		t.Helper()
		if e := f.s.Put("node-observability", "rotation-host", s); e != nil {
			t.Fatal(e)
		}
	}
	put(t, attributedProviderState("provider_statement", time.Now().UTC()))
	check(t, false, false) // RED against advisory-only gate, not an unavailable-only fixture.
	var p httpapi.Profile
	if e := f.s.TenantGet(f.owner.id, "profiles", "rotation-profile", &p); e != nil {
		t.Fatal(e)
	}
	p.IR.Rules = []domain.PolicyRule{{ID: "direct-example", Match: domain.MatchExpression{Op: "domain", Value: "example.com"}, Action: domain.ActionRef{Kind: "direct"}}}
	if e := f.s.TenantPut(f.owner.id, "profiles", p.ID, p); e != nil {
		t.Fatal(e)
	}
	for _, source := range []string{"provider_statement", "nic_estimate"} {
		t.Run(source, func(t *testing.T) {
			fresh := func() observability.State { return attributedProviderState(source, time.Now().UTC()) }
			put(t, fresh())
			check(t, true, false)
			for _, mode := range []string{"missing-selected-evidence", "stale", "future", "exhausted", "wrong-cycle", "cycle-ended", "cycle-not-started", "expired", "policy-source-change", "invalid-policy", "negative-statement", "negative-observed", "negative-baseline", "negative-baseline-counter", "nic-baseline-exhausted", "baseline-after-counter", "nic-overflow"} {
				t.Run(mode, func(t *testing.T) {
					makeBad := func() observability.State {
						s := fresh()
						now := time.Now().UTC()
						switch mode {
						case "missing-selected-evidence":
							if source == "provider_statement" {
								s.Statement = nil
							} else {
								s.Baseline = nil
							}
						case "stale":
							if source == "provider_statement" {
								s.Statement.ObservedAt = now.Add(-observability.FreshFor - time.Second)
							} else {
								s.Latest.ObservedAt = now.Add(-observability.FreshFor - time.Second)
							}
						case "future":
							if source == "provider_statement" {
								s.Statement.ObservedAt = now.Add(2 * time.Minute)
							} else {
								s.Latest.ObservedAt = now.Add(2 * time.Minute)
							}
						case "exhausted":
							if source == "provider_statement" {
								s.Statement.UsedBytes = 1000000000
							} else {
								s.ObservedNICBytes = 1000000000
							}
						case "wrong-cycle":
							if source == "provider_statement" {
								s.Statement.CycleID = "other"
							} else {
								s.Baseline.CycleID = "other"
							}
						case "cycle-ended":
							s.Config.Provider.CycleEnd = now
						case "cycle-not-started":
							s.Config.Provider.CycleStart = now.Add(time.Minute)
						case "expired":
							s.Config.Provider.ExpiresAt = &now
						case "policy-source-change":
							if source == "provider_statement" {
								s.Config.Provider.NotificationSource = "nic_estimate"
								s.Baseline = nil
							} else {
								s.Config.Provider.NotificationSource = "provider_statement"
								s.Statement = nil
							}

						case "negative-statement":
							s.Statement.UsedBytes = -1
						case "negative-observed":
							s.ObservedNICBytes = -1
						case "negative-baseline":
							s.Baseline.UsedBytes = -1
						case "negative-baseline-counter":
							s.Baseline.NICBytesAtBaseline = -1
						case "nic-baseline-exhausted":
							s.Config.Provider.NotificationSource = "nic_estimate"
							s.Baseline.UsedBytes = 1000000000

						case "baseline-after-counter":
							s.Baseline.NICBytesAtBaseline = s.ObservedNICBytes + 1
						case "nic-overflow":
							s.Config.Provider.NotificationSource = "nic_estimate"
							s.ObservedNICBytes = math.MaxInt64
							s.Baseline.NICBytesAtBaseline = 0
							s.Baseline.UsedBytes = 1
						case "invalid-policy":
							s.Config.Provider.NotificationSource = "none"
						}
						return s
					}
					bad := makeBad()
					if reason, _ := observability.ManagedAdmission(bad, time.Now().UTC()); reason == "" && !strings.HasPrefix(mode, "negative-") && mode != "baseline-after-counter" {
						t.Fatal("bad fixture unexpectedly admission-eligible", mode)
					}
					put(t, bad)
					check(t, false, true)
					put(t, fresh())
					check(t, true, false)
					got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() { put(t, makeBad()) })
					if got["state"] != "unavailable" {
						t.Fatal("post-render provider invalidation admitted", mode, got)
					}
					put(t, fresh())
					check(t, true, false)
				})
			}
		})
	}
	// An unrelated node must not poison this path's provider eligibility.
	put(t, attributedProviderState("provider_statement", time.Now().UTC()))
	foreign := attributedProviderState("provider_statement", time.Now().UTC())
	foreign.Statement.UsedBytes = 1000000000
	if e := f.s.Put("node-observability", "unrelated-node", foreign); e != nil {
		t.Fatal(e)
	}
	check(t, true, false)
	// Time alone invalidates unchanged evidence. Wait only after the first render,
	// avoiding a sleep that could make initial admission accidentally stale.
	deadline := time.Now().Add(3 * time.Second)
	timed := attributedProviderState("provider_statement", time.Now().UTC())
	timed.Statement.ObservedAt = deadline.Add(-observability.FreshFor)
	put(t, timed)
	got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() { time.Sleep(time.Until(deadline) + 20*time.Millisecond) })
	if got["state"] != "unavailable" {
		t.Fatal("same provider evidence survived freshness expiry", got)
	}
	check(t, false, true)

}

func TestActionsAttributedProviderChecksEveryPathHost(t *testing.T) {
	f := newActionsAttributedFixtureFromRotation(t, newRotationRecoveryFixtureAtHosts(t, 12345, 12346, true))
	var published httpapi.Output
	if e := f.s.TenantGet(f.owner.id, "outputs", "isolated", &published); e != nil {
		t.Fatal(e)
	}
	check := func(unchecked bool) {
		t.Helper()
		code, v, raw := req(t, f.owner.c, "GET", f.srv.URL+"/api/me/actions", "", nil)
		if code != 200 || (len(v["uncheckedOutputs"].([]any)) == 1) != unchecked {
			t.Fatal(raw)
		}
		var after httpapi.Output
		if e := f.s.TenantGet(f.owner.id, "outputs", "isolated", &after); e != nil || !reflect.DeepEqual(after, published) {
			t.Fatal("output changed", e)
		}
	}
	fresh := func() observability.State { return attributedProviderState("provider_statement", time.Now().UTC()) }
	put := func(node string, state observability.State) {
		t.Helper()
		if e := f.s.Put("node-observability", node, state); e != nil {
			t.Fatal(e)
		}
	}
	put("rotation-host", fresh())
	put("rotation-transit-host", fresh())
	check(false)
	for _, node := range []string{"rotation-host", "rotation-transit-host"} {
		bad := fresh()
		bad.Statement.UsedBytes = 1000000000
		put(node, bad)
		check(true)
		put(node, fresh())
		check(false)
		got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() { put(node, bad) })
		if got["state"] != "unavailable" {
			t.Fatal("changed hop provider admitted", node, got)
		}
		put(node, fresh())
		check(false)
	}
}
