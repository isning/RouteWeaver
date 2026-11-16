package httpapi_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
)

// Exercise actual reservation, provisioning and publication. Applied observations
// are synthetic; no native process or production deployment runs in this test.
func newActionsAttributedFixture(t *testing.T, extra ...string) *rotationRecoveryFixture {
	t.Helper()
	f := newRotationRecoveryFixture(t, extra...)
	if len(extra) > 0 {
		var p httpapi.Profile
		if err := f.s.TenantGet(f.owner.id, "profiles", "rotation-profile", &p); err != nil {
			t.Fatal(err)
		}
		p.PlatformEntryIDs = append(p.PlatformEntryIDs, extra...)
		if err := f.s.TenantPut(f.owner.id, "profiles", p.ID, p); err != nil {
			t.Fatal(err)
		}
	}
	input := map[string]any{"action": "configure", "deploymentId": "rotation-path", "targetIds": []string{"rotation-core", "rotation-transit"}, "continuousService": true}
	plan := f.postAdmin("admin/fleet-batches/preview", input)
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 300
	batch := f.postAdmin("admin/fleet-batches", input)
	f.postAdmin("admin/fleet-batches/"+batch["id"].(string)+"/execute", map[string]any{"stage": 0, "requestId": "actions-attributed-baseline"})
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	code, _, raw := req(t, f.admin, "PUT", f.srv.URL+"/api/server-deployments/rotation-path/principal-delegation", "", map[string]any{"enabled": true, "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 8, "maxPendingIntents": 2, "allowRuntimeRestart": true, "expiresAt": time.Now().Add(time.Hour)})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/independent", f.owner.csrf, map[string]string{"id": "isolated", "name": "Independent", "profileId": "rotation-profile"})
	if code != 202 {
		t.Fatal(raw)
	}
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "isolated"); state != "provisioning" {
		t.Fatal(state)
	}
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "isolated"); state != "published" {
		t.Fatal(state)
	}
	return f
}

func TestActionsAttributedPlatformRealPublication(t *testing.T) {
	f := newActionsAttributedFixture(t)
	var output httpapi.Output
	if err := f.s.TenantGet(f.owner.id, "outputs", "isolated", &output); err != nil {
		t.Fatal(err)
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
			t.Fatalf("changed=%v unchecked=%v: %s", changed, unchecked, raw)
		}
		var saved httpapi.Output
		if err := f.s.TenantGet(f.owner.id, "outputs", "isolated", &saved); err != nil || !reflect.DeepEqual(saved, output) {
			t.Fatal("automatic comparison changed output", err)
		}
	}
	check(t, false, false)
	var profile httpapi.Profile
	if err := f.s.TenantGet(f.owner.id, "profiles", "rotation-profile", &profile); err != nil {
		t.Fatal(err)
	}
	profile.IR.Rules = []domain.PolicyRule{{ID: "direct-example", Match: domain.MatchExpression{Op: "domain", Value: "example.com"}, Action: domain.ActionRef{Kind: "direct"}}}
	if err := f.s.TenantPut(f.owner.id, "profiles", profile.ID, profile); err != nil {
		t.Fatal(err)
	}
	check(t, true, false)
	// Find the real isolated binding emitted by the provisioning transaction.
	rows, err := f.s.List("entry-admission-bindings")
	if err != nil {
		t.Fatal(err)
	}
	var binding store.EntryAdmissionBinding
	for _, raw := range rows {
		var b store.EntryAdmissionBinding
		if json.Unmarshal(raw, &b) != nil {
			t.Fatal("binding decode")
		}
		if b.OutputID == "isolated" {
			binding = b
			break
		}
	}
	if binding.GrantID == "" {
		t.Fatal("real isolated binding missing")
	}
	record, err := store.EntryAdmissionBindingRecord(binding)
	if err != nil {
		t.Fatal(err)
	}
	// Each corruption must fail closed, then recover without republishing.
	mutate := func(name, kind, id string, change func(map[string]any)) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			var original json.RawMessage
			if e := f.s.Get(kind, id, &original); e != nil {
				t.Fatal(e)
			}
			var v map[string]any
			if e := json.Unmarshal(original, &v); e != nil {
				t.Fatal(e)
			}
			change(v)
			if e := f.s.Put(kind, id, v); e != nil {
				t.Fatal(e)
			}
			check(t, false, true)
			if e := f.s.Put(kind, id, original); e != nil {
				t.Fatal(e)
			}
			check(t, true, false)
			got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() {
				if e := f.s.Put(kind, id, v); e != nil {
					t.Fatal(e)
				}
			})
			if got["state"] != "unavailable" {
				t.Fatal("second capture admitted changed proof", got)
			}
			if e := f.s.Put(kind, id, original); e != nil {
				t.Fatal(e)
			}
			check(t, true, false)
		})
	}
	grantKind := store.TenantKind(f.owner.id, "platform-entries")
	mutate("isolated-revoked", grantKind, binding.GrantID, func(v map[string]any) { v["revoked"] = true })
	mutate("isolated-foreign-owner", grantKind, binding.GrantID, func(v map[string]any) { v["userId"] = f.other.id })
	mutate("isolated-version", grantKind, binding.GrantID, func(v map[string]any) { v["outputRevision"] = "different" })
	mutate("binding-version", "entry-admission-bindings", record.ID, func(v map[string]any) { v["outputRevision"] = "different" })
	mutate("claim-owner", "output-attribution-claims", record.ID, func(v map[string]any) { v["binding"].(map[string]any)["userId"] = f.other.id })
	mutate("intent-state", store.TenantKind(f.owner.id, "output-attribution-intents"), "isolated", func(v map[string]any) { v["state"] = "cancelling" })
	mutate("intent-version", store.TenantKind(f.owner.id, "output-attribution-intents"), "isolated", func(v map[string]any) { v["revision"] = "different" })
	mutate("intent-mapping", store.TenantKind(f.owner.id, "output-attribution-intents"), "isolated", func(v map[string]any) {
		v["output"].(map[string]any)["attribution"].(map[string]any)["grants"].(map[string]any)["rotation-grant"] = "different"
	})

	for _, kind := range []string{"entry-admission-bindings", "output-attribution-claims"} {
		t.Run("missing-"+kind, func(t *testing.T) {
			var raw json.RawMessage
			if err := f.s.Get(kind, record.ID, &raw); err != nil {
				t.Fatal(err)
			}
			if err := f.s.CompareSetsAndRemoveRecord(kind, record.ID, []store.RecordCompare{{Kind: kind, ID: record.ID, Expected: raw}}, nil); err != nil {
				t.Fatal(err)
			}
			check(t, false, true)
			if err := f.s.Put(kind, record.ID, raw); err != nil {
				t.Fatal(err)
			}
			check(t, true, false)
		})
	}

	mutate("entry-instance-host", "core-instances", "rotation-core", func(v map[string]any) { v["hostId"] = "different-host" })
	mutate("transit-instance-version", "core-instances", "rotation-transit", func(v map[string]any) { v["version"] = "different-version" })
	mutate("transit-proof-incomplete", "agent-observations", "rotation-transit", func(v map[string]any) { v["phase"] = "unknown" })
	mutate("enrollment-expiry", "instance-enrollments", "rotation-core", func(v map[string]any) { v["expiresAt"] = time.Now().Add(-time.Second).Format(time.RFC3339Nano) })
	for _, kind := range []string{"entry-admission-bindings", "output-attribution-claims"} {
		var raw json.RawMessage
		if e := f.s.Get(kind, record.ID, &raw); e != nil {
			t.Fatal(e)
		}
		got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() {
			if e := f.s.CompareSetsAndRemoveRecord(kind, record.ID, []store.RecordCompare{{Kind: kind, ID: record.ID, Expected: raw}}, nil); e != nil {
				t.Fatal(e)
			}
		})
		if got["state"] != "unavailable" {
			t.Fatal("second capture deleted proof admitted", kind, got)
		}
		if e := f.s.Put(kind, record.ID, raw); e != nil {
			t.Fatal(e)
		}
		check(t, true, false)
	}
	got := httpapi.CompareAttributedCaptureForTest(t, f.s, f.owner.id, "isolated", func() {
		if e := f.s.Put("node-observability", "rotation-host", observability.State{Config: observability.Config{Provider: &observability.ProviderConfig{ExhaustionAction: "suspend-managed"}}}); e != nil {
			t.Fatal(e)
		}
	})
	if got["state"] != "unavailable" {
		t.Fatal("second capture provider insertion admitted", got)
	}
	if e := f.s.Put("node-observability", "rotation-host", observability.State{}); e != nil {
		t.Fatal(e)
	}
	check(t, true, false)
	// Revocation of the original shared credential does not revoke its isolated sibling.
	var original httpapi.PublicEntryGrant
	if err := f.s.TenantGet(f.owner.id, "platform-entries", "rotation-grant", &original); err != nil {
		t.Fatal(err)
	}
	original.Revoked = true
	if err := f.s.TenantPut(f.owner.id, "platform-entries", "rotation-grant", original); err != nil {
		t.Fatal(err)
	}
	check(t, true, false)
	// No provider policy and advisory are supported; enforcement is deliberately deferred.
	for _, mode := range []string{"advisory", "suspend-managed"} {
		state := observability.State{Config: observability.Config{Provider: &observability.ProviderConfig{ExhaustionAction: mode}}}
		if err := f.s.Put("node-observability", "rotation-host", state); err != nil {
			t.Fatal(err)
		}
		check(t, mode == "advisory", mode != "advisory")
	}

	now := time.Now().UTC()
	fresh := observability.State{Config: observability.Config{Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "suspend-managed"}}, Statement: &observability.Statement{StatementInput: observability.StatementInput{CycleID: "cycle", UsedBytes: 10, ObservedAt: now}}}
	if err := observability.ValidateConfig(fresh.Config); err != nil {
		t.Fatal(err)
	}
	if reason, _ := observability.ManagedAdmission(fresh, now); reason != "" {
		t.Fatal("fixture should permit real managed admission", reason)
	}
	if err := f.s.Put("node-observability", "rotation-host", fresh); err != nil {
		t.Fatal(err)
	}
	check(t, false, true)
	code, v, raw := req(t, f.other.c, "GET", f.srv.URL+"/api/me/actions", "", nil)
	if code != 200 {
		t.Fatal(raw)
	}
	for _, x := range v["items"].([]any) {
		if x.(map[string]any)["id"] == "output:isolated" {
			t.Fatal("foreign output exposed")
		}
	}
}

func TestActionsAttributedMappingCannotSwapIsolatedGrants(t *testing.T) {
	f := newActionsAttributedFixture(t, "rotation-grant-two")
	check := func(unchecked bool) {
		t.Helper()
		code, v, raw := req(t, f.owner.c, "GET", f.srv.URL+"/api/me/actions", "", nil)
		if code != 200 {
			t.Fatal(raw)
		}
		if (len(v["uncheckedOutputs"].([]any)) == 1) != unchecked {
			t.Fatal(raw)
		}
	}
	check(false)
	var original json.RawMessage
	if err := f.s.TenantGet(f.owner.id, "outputs", "isolated", &original); err != nil {
		t.Fatal(err)
	}
	var output map[string]any
	if err := json.Unmarshal(original, &output); err != nil {
		t.Fatal(err)
	}
	grants := output["attribution"].(map[string]any)["grants"].(map[string]any)
	grants["rotation-grant"], grants["rotation-grant-two"] = grants["rotation-grant-two"], grants["rotation-grant"]
	if err := f.s.TenantPut(f.owner.id, "outputs", "isolated", output); err != nil {
		t.Fatal(err)
	}
	check(true)
	var after map[string]any
	if err := f.s.TenantGet(f.owner.id, "outputs", "isolated", &after); err != nil || !reflect.DeepEqual(after, output) {
		t.Fatal("comparison mutated swapped publication", err)
	}
	if err := f.s.TenantPut(f.owner.id, "outputs", "isolated", original); err != nil {
		t.Fatal(err)
	}
	check(false)
}
