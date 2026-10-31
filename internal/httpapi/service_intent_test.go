package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func createContinuousBatch(t *testing.T, f fleetFixture, enabled bool) string {
	t.Helper()
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["continuousService"] = enabled
	plan := f.post(t, "admin/fleet-batches/preview", in, 200)
	in["expectedFingerprint"] = plan["fingerprint"]
	in["leaseSeconds"] = 300
	return f.post(t, "admin/fleet-batches", in, 201)["id"].(string)
}
func serviceHeartbeatRequest(t *testing.T, f fleetFixture, token string, h controlprotocol.ServiceHeartbeat) (int, controlprotocol.ServiceHeartbeatResult) {
	t.Helper()
	raw, _ := json.Marshal(h)
	r, _ := http.NewRequest("POST", f.srv.URL+"/api/agent/instances/"+h.Desired.InstanceID+"/service-heartbeat", bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-RouteWeaver-Node", h.Desired.NodeID)
	r.Header.Set("X-RouteWeaver-Enrollment", h.Desired.EnrollmentEpoch)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	var result controlprotocol.ServiceHeartbeatResult
	if response.StatusCode == 200 {
		if err = json.Unmarshal(body, &result); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
	}
	return response.StatusCode, result
}
func TestContinuousServiceRequiresReviewedOptInAndKeepsManualDefault(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		f := newFleetFixture(t)
		id := createContinuousBatch(t, f, enabled)
		f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "start"}, 200)
		status, out, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/fleet-a/state", "", nil)
		if status != 200 {
			t.Fatal(raw)
		}
		intent, ok := out["serviceIntent"].(map[string]any)
		if enabled && (!ok || intent["running"] != true || intent["automaticAttempts"] != float64(0) || intent["status"] != "awaiting_observation") {
			t.Fatalf("reviewed service intent missing: %s", raw)
		}
		if !enabled && ok && intent["running"] == true {
			t.Fatal("manual batch enabled recovery")
		}
	}
	f := newFleetFixture(t)
	f.in.Action = "stop"
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["continuousService"] = true
	f.post(t, "admin/fleet-batches/preview", in, 422)
}

func continuousFixture(t *testing.T) (fleetFixture, string, string, controlprotocol.Desired) {
	t.Helper()
	f := newFleetFixture(t)
	return continuousFixtureFrom(t, f)
}
func continuousFixtureFrom(t *testing.T, f fleetFixture) (fleetFixture, string, string, controlprotocol.Desired) {
	t.Helper()
	enrollment := f.post(t, "agent/enrollments", map[string]any{"nodeId": "host-fleet-a", "instanceId": "fleet-a", "expiresAt": time.Now().Add(time.Hour)}, 201)
	id := createContinuousBatch(t, f, true)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "start"}, 200)
	var d controlprotocol.Desired
	if err := f.s.Get("agent-desired", "fleet-a", &d); err != nil {
		t.Fatal(err)
	}
	return f, id, enrollment["token"].(string), d
}

// Seed a valid near-expiry durable image to exercise the renewal seam without a
// five-minute wall-clock wait. Activation identity and all reviewed inputs stay.
func ageContinuousLease(t *testing.T, f fleetFixture, d *controlprotocol.Desired) {
	t.Helper()
	d.Lease.IssuedAt = time.Now().UTC().Add(-290 * time.Second)
	d.Lease.ExpiresAt = d.Lease.IssuedAt.Add(300 * time.Second)
	if err := f.s.Put("agent-desired", d.InstanceID, *d); err != nil {
		t.Fatal(err)
	}
	var intent map[string]any
	if err := f.s.Get("agent-service-intents", d.InstanceID, &intent); err != nil {
		t.Fatal(err)
	}
	intent["lease"] = d.Lease
	if err := f.s.Put("agent-service-intents", d.InstanceID, intent); err != nil {
		t.Fatal(err)
	}
}
func clearServiceThrottle(t *testing.T, f fleetFixture, id string) {
	t.Helper()
	var v map[string]any
	if err := f.s.Get("agent-service-intents", id, &v); err != nil {
		t.Fatal(err)
	}
	v["validationNotBefore"] = time.Now().Add(-time.Second).UTC()
	if err := f.s.Put("agent-service-intents", id, v); err != nil {
		t.Fatal(err)
	}
}
func liveServiceFact(d controlprotocol.Desired) controlprotocol.ServiceHeartbeat {
	return controlprotocol.ServiceHeartbeat{Desired: d.Identity(), Observed: controlprotocol.Observation{Identity: d.Identity(), Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}, PolicyIssuedAt: d.Lease.IssuedAt, ServiceActive: true}
}
func TestContinuousServiceRefreshIsDurableIdentityBoundAndAcknowledged(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	ageContinuousLease(t, f, &d)
	before := controlprotocol.RequestDigest(d)
	fact := liveServiceFact(d)
	code, result := serviceHeartbeatRequest(t, f, token, fact)
	if code != 200 || result.PolicyRefresh == nil {
		t.Fatalf("no refresh: %d %+v", code, result)
	}
	refresh := *result.PolicyRefresh
	if refresh.Identity != d.Identity() || refresh.Sequence != 1 || refresh.IntentID == "" || !refresh.Lease.IssuedAt.After(d.Lease.IssuedAt) {
		t.Fatal("refresh identity or monotonic grant missing")
	}
	var unchanged controlprotocol.Desired
	f.s.Get("agent-desired", d.InstanceID, &unchanged)
	if controlprotocol.RequestDigest(unchanged) != before {
		t.Fatal("refresh rewrote immutable desired")
	}
	clearServiceThrottle(t, f, d.InstanceID)
	code, retry := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
	if code != 200 || retry.PolicyRefresh == nil || *retry.PolicyRefresh != refresh {
		t.Fatalf("lost-response retry changed grant: status=%d got=%+v want=%+v", code, retry, refresh)
	}
	clearServiceThrottle(t, f, d.InstanceID)
	fact.PolicyIssuedAt = refresh.Lease.IssuedAt
	fact.Observed.ObservedAt = time.Now().UTC()
	code, result = serviceHeartbeatRequest(t, f, token, fact)
	if code != 204 || result.PolicyRefresh != nil {
		t.Fatal("ack minted another grant")
	}
	var manifest struct {
		PolicyExpiresAt time.Time `json:"policyExpiresAt"`
	}
	f.s.Get("published-manifests", d.RevisionID, &manifest)
	if !manifest.PolicyExpiresAt.Equal(refresh.Lease.ExpiresAt) {
		t.Fatal("exact accepted refresh did not advance publication lease")
	}
}
func TestContinuousServiceRejectsUnsafeFactsAndNeverSelfAuthorizes(t *testing.T) {
	for _, scenario := range []string{"unknown", "nonquiescent", "wrong_identity", "inactive_driver", "stale_observation", "future_policy", "expired_live", "stop", "changed_configuration"} {
		t.Run(scenario, func(t *testing.T) {
			f, _, token, d := continuousFixture(t)
			ageContinuousLease(t, f, &d)
			fact := liveServiceFact(d)
			switch scenario {
			case "unknown":
				fact.Observed.Known = false
			case "nonquiescent":
				fact.Observed.Quiescent = false
			case "wrong_identity":
				fact.Observed.Generation++
			case "inactive_driver":
				fact.ServiceActive = false
			case "stale_observation":
				fact.Observed.ObservedAt = time.Now().Add(-time.Minute)
			case "future_policy":
				fact.PolicyIssuedAt = time.Now().Add(time.Hour)
			case "expired_live":
				d.Lease.ExpiresAt = time.Now().Add(-time.Second)
				f.s.Put("agent-desired", d.InstanceID, d)
				var v map[string]any
				f.s.Get("agent-service-intents", d.InstanceID, &v)
				v["lease"] = d.Lease
				f.s.Put("agent-service-intents", d.InstanceID, v)
			case "stop":
				f.in.Action = "stop"
				f.in.TargetIDs = []string{"fleet-a"}
				f.in.Stages = nil
				id := f.create(t)
				f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
			case "changed_configuration":
				var v map[string]any
				f.s.Get("server-deployments", f.in.DeploymentID, &v)
				v["name"] = "renamed"
				ir := v["ir"].(map[string]any)
				ir["topologyRevision"] = "changed"
				f.s.Put("server-deployments", f.in.DeploymentID, v)
			}
			_, result := serviceHeartbeatRequest(t, f, token, fact)
			if result.PolicyRefresh != nil {
				t.Fatal("unsafe fact obtained lease")
			}
			var current controlprotocol.Desired
			f.s.Get("agent-desired", d.InstanceID, &current)
			if scenario != "stop" && current.Generation != d.Generation {
				t.Fatal("unsafe fact queued activation")
			}
		})
	}
}

func TestContinuousServiceRecoveryBackoffBudgetAndStopAreDurable(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	var stableID string
	for attempt := 0; attempt < 3; attempt++ {
		fact := liveServiceFact(d)
		fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
		code, result := serviceHeartbeatRequest(t, f, token, fact)
		if code != 204 || result.PolicyRefresh != nil {
			t.Fatalf("absence should schedule backoff: %d %+v", code, result)
		}
		var state map[string]any
		f.s.Get("agent-service-intents", d.InstanceID, &state)
		if attempt == 0 {
			stableID = state["id"].(string)
		} else if state["id"] != stableID {
			t.Fatal("recovery reset stable intent")
		}
		if state["status"] != "recovery_backoff" || state["automaticAttempts"] != float64(attempt) {
			t.Fatalf("missing durable budget: %+v", state)
		}
		deadline, err := time.Parse(time.RFC3339Nano, state["nextAttemptAt"].(string))
		if err != nil {
			t.Fatal(err)
		}
		if time.Until(deadline) < time.Duration(4*(1<<attempt))*time.Second {
			t.Fatal("backoff shorter than configured")
		}
		serviceHeartbeatRequest(t, f, token, fact)
		var unchanged controlprotocol.Desired
		f.s.Get("agent-desired", d.InstanceID, &unchanged)
		if unchanged.Generation != d.Generation {
			t.Fatal("backoff ignored")
		}
		// Reopen a persisted eligible scheduling image; budget is not process-local.
		state["nextAttemptAt"] = time.Now().Add(-time.Second).UTC()
		state["validationNotBefore"] = time.Now().Add(-time.Second).UTC()
		f.s.Put("agent-service-intents", d.InstanceID, state)
		fact.Observed.ObservedAt = time.Now().UTC()
		code, _ = serviceHeartbeatRequest(t, f, token, fact)
		if code != 204 {
			t.Fatalf("eligible recovery=%d", code)
		}
		var next controlprotocol.Desired
		f.s.Get("agent-desired", d.InstanceID, &next)
		if next.Generation != d.Generation+1 || next.OperationID == d.OperationID {
			t.Fatal("recovery did not issue exactly new identity")
		}
		if code, _ = serviceHeartbeatRequest(t, f, token, fact); code != 409 {
			t.Fatal("old absence replay accepted after generation change")
		}
		d = next
		clearServiceThrottle(t, f, d.InstanceID)
	}
	fact := liveServiceFact(d)
	fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
	serviceHeartbeatRequest(t, f, token, fact)
	var state map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &state)
	if state["status"] != "crash_loop_blocked" || state["automaticAttempts"] != float64(3) {
		t.Fatalf("cap lost: %+v", state)
	}
	// A new explicitly reviewed manual stop disables the standing authority.
	f.in.Action = "stop"
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	stop := f.create(t)
	f.post(t, "admin/fleet-batches/"+stop+"/execute", map[string]any{"stage": 0, "requestId": "maintenance"}, 200)
	f.s.Get("agent-service-intents", d.InstanceID, &state)
	if state["running"] != false || state["status"] != "disabled" {
		t.Fatal("stop left continuous authority")
	}
}

func TestContinuousServiceConcurrentHeartbeatsIssueOneRefresh(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	ageContinuousLease(t, f, &d)
	results := make(chan *controlprotocol.PolicyRefresh, 8)
	for i := 0; i < 8; i++ {
		go func() { _, r := serviceHeartbeatRequest(t, f, token, liveServiceFact(d)); results <- r.PolicyRefresh }()
	}
	var grant *controlprotocol.PolicyRefresh
	for i := 0; i < 8; i++ {
		if r := <-results; r != nil {
			if grant != nil && *grant != *r {
				t.Fatal("concurrent renew generated different grants")
			}
			grant = r
		}
	}
	if grant == nil || grant.Sequence != 1 {
		t.Fatal("no single first grant")
	}
	var v map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &v)
	if v["sequence"] != "1" {
		t.Fatal("concurrency advanced sequence repeatedly")
	}
}

func TestContinuousServicePendingRefreshSurvivesDatabaseAndHandlerRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.db")
	key := bytes.Repeat([]byte{11}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpapi.New(s, render.Default(), "012345678901234567890123456789012345", ""))
	f, _, token, d := continuousFixtureFrom(t, fleetFixtureAt(t, s, server))
	ageContinuousLease(t, f, &d)
	code, issued := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
	if code != 200 || issued.PolicyRefresh == nil {
		t.Fatal("no initial durable refresh")
	}
	clearServiceThrottle(t, f, d.InstanceID)
	server.Close()
	s.Close()
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	server = httptest.NewServer(httpapi.New(s, render.Default(), "012345678901234567890123456789012345", ""))
	defer server.Close()
	f.s = s
	f.srv = server
	code, replayed := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
	if code != 200 || replayed.PolicyRefresh == nil || *replayed.PolicyRefresh != *issued.PolicyRefresh {
		t.Fatal("restart lost exact pending grant")
	}
	// Runtime dies before applying the pending lease. Absence is not an ACK and
	// only a new generation may recover; the pending grant cannot activate it.
	clearServiceThrottle(t, f, d.InstanceID)
	fact := liveServiceFact(d)
	fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
	code, result := serviceHeartbeatRequest(t, f, token, fact)
	if code != 204 || result.PolicyRefresh != nil {
		t.Fatal("absence replayed pending grant")
	}
	var intent map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	if intent["pendingRefresh"] == nil || intent["status"] != "recovery_backoff" {
		t.Fatal("pending obligation changed before new generation")
	}
	intent["nextAttemptAt"] = time.Now().Add(-time.Second).UTC()
	intent["validationNotBefore"] = time.Now().Add(-time.Second).UTC()
	f.s.Put("agent-service-intents", d.InstanceID, intent)
	serviceHeartbeatRequest(t, f, token, fact)
	intent = nil
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	if intent["pendingRefresh"] != nil {
		t.Fatal("new generation retained obsolete refresh")
	}
	var next controlprotocol.Desired
	f.s.Get("agent-desired", d.InstanceID, &next)
	if next.Generation != d.Generation+1 {
		t.Fatal("absence did not authorize new generation")
	}
}

func TestContinuousServiceRevokedAdministratorCannotRenewOrRecover(t *testing.T) {
	for _, flag := range []string{"disabled", "retired", "passwordChangeRequired", "role"} {
		t.Run(flag, func(t *testing.T) {
			f, _, token, d := continuousFixture(t)
			ageContinuousLease(t, f, &d)
			account := map[string]any{"id": "service-admin", "role": "admin", "disabled": false, "retired": false, "passwordChangeRequired": false}
			if flag == "role" {
				account[flag] = "user"
			} else {
				account[flag] = true
			}
			if err := f.s.Put("accounts", "service-admin", account); err != nil {
				t.Fatal(err)
			}
			var intent map[string]any
			f.s.Get("agent-service-intents", d.InstanceID, &intent)
			intent["actorId"] = "service-admin"
			f.s.Put("agent-service-intents", d.InstanceID, intent)
			_, result := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
			if result.PolicyRefresh != nil {
				t.Fatal("revoked administrator renewed")
			}
			f.s.Get("agent-service-intents", d.InstanceID, &intent)
			if intent["status"] != "review_required" {
				t.Fatal("revoked authority not visible")
			}
			fact := liveServiceFact(d)
			fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
			serviceHeartbeatRequest(t, f, token, fact)
			var current controlprotocol.Desired
			f.s.Get("agent-desired", d.InstanceID, &current)
			if current.Generation != d.Generation {
				t.Fatal("revoked administrator restarted runtime")
			}
		})
	}
}

func managedServiceFixture(t *testing.T) (fleetFixture, sessionClient, int) {
	port := publishedFreePort(t)
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	alice := inviteClient(t, f.s, f.srv, "service-alice")
	instance := domain.CoreInstance{ID: "fleet-a", Name: "Managed entry", HostID: "host-fleet-a", AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}
	endpoint := domain.ManagedEndpoint{ID: "entry-fleet-a", InstanceID: instance.ID, Name: "Managed public", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: port, UUID: "00000000-0000-4000-8000-000000000001"}}
	f.post(t, "core-instances", instance, 200)
	f.post(t, "managed-endpoints", endpoint, 200)
	deployment := httpapi.ServerDeployment{ID: f.in.DeploymentID, Name: "Managed fleet", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: f.in.DeploymentID, TopologyRevision: "fleet-topology", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint, DestinationPolicy: &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}}}}}
	f.saveDeployment(t, deployment)
	f.post(t, "published-routes", map[string]any{"id": "fleet-route", "name": "Managed route", "deploymentId": deployment.ID, "endpointIds": []string{endpoint.ID}, "publicHost": "127.0.0.1", "publicPort": port}, 200)
	plan := service.Plan{ID: "fleet-plan", Name: "Managed plan", QuotaBytes: 1 << 20, RouteIDs: []string{"fleet-route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	f.post(t, "services", plan, 200)
	if code, _, raw := req(t, operatorClient(), "PUT", f.srv.URL+"/api/users/"+alice.id+"/entitlement", "", service.Entitlement{ServiceID: plan.ID, Cycle: plan.Cycle}); code != 200 {
		t.Fatal(code, raw)
	}
	f.post(t, "published-routes/fleet-route/principals", map[string]any{"accountId": alice.id, "entryId": "alice-entry", "credentialVersion": "v1", "credential": domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000011"}}, 201)
	return f, alice, port
}

func TestContinuousManagedPrincipalLoginDoesNotRevokeServiceButDisabledAccountDoes(t *testing.T) {
	f, alice, _ := managedServiceFixture(t)
	f, _, token, d := continuousFixtureFrom(t, f)
	ageContinuousLease(t, f, &d)
	var account store.Account
	if err := f.s.Get("accounts", alice.id, &account); err != nil {
		t.Fatal(err)
	}
	account.LastTOTPStep++
	var user domain.User
	if err := f.s.Get("users", alice.id, &user); err != nil {
		t.Fatal(err)
	}
	user.UsedBytes = 100
	if err := f.s.Put("users", alice.id, user); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Put("accounts", alice.id, account); err != nil {
		t.Fatal(err)
	}
	code, result := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
	if code != 200 || result.PolicyRefresh == nil {
		t.Fatal("normal login bookkeeping revoked standing service", code)
	}
	clearServiceThrottle(t, f, d.InstanceID)
	account.Disabled = true
	if err := f.s.Put("accounts", alice.id, account); err != nil {
		t.Fatal(err)
	}
	_, result = serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
	if result.PolicyRefresh != nil {
		t.Fatal("disabled principal renewed")
	}
	var intent map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	if intent["status"] != "review_required" {
		t.Fatal("permission change was not blocked")
	}
}

func TestContinuousServiceFlagCannotCreateAuthorityWithoutCPOptIn(t *testing.T) {
	f := newFleetFixture(t)
	enrollment := f.post(t, "agent/enrollments", map[string]any{"nodeId": "host-fleet-a", "instanceId": "fleet-a", "expiresAt": time.Now().Add(time.Hour)}, 201)
	batch := createContinuousBatch(t, f, false)
	f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "bounded-manual"}, 200)
	var d controlprotocol.Desired
	f.s.Get("agent-desired", "fleet-a", &d)
	code, result := serviceHeartbeatRequest(t, f, enrollment["token"].(string), liveServiceFact(d))
	if code != 204 || result.PolicyRefresh != nil {
		t.Fatal("agent flag self-authorized continuing lease")
	}
	var next controlprotocol.Desired
	f.s.Get("agent-desired", "fleet-a", &next)
	if next.Identity() != d.Identity() || next.Lease != d.Lease {
		t.Fatal("manual authorization changed")
	}
}

func TestContinuousManagedCurrentQuotaAndAccountingHoldBlockRefresh(t *testing.T) {
	for _, scenario := range []string{"quota-exhausted", "accounting-hold"} {
		t.Run(scenario, func(t *testing.T) {
			f, user, _ := managedServiceFixture(t)
			f, _, token, d := continuousFixtureFrom(t, f)
			ageContinuousLease(t, f, &d)
			if scenario == "quota-exhausted" {
				if err := f.s.RecordMeter(store.MeterBatch{UserID: user.id, RouteID: "fleet-route", MeterID: "service-quota", Epoch: "epoch", Sequence: 1, RawBytes: 1 << 20, ObservedAt: time.Now().UTC()}); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := f.s.Put("accounting-holds", "service-hold", store.AccountingHold{UserID: user.id}); err != nil {
					t.Fatal(err)
				}
			}
			_, result := serviceHeartbeatRequest(t, f, token, liveServiceFact(d))
			if result.PolicyRefresh != nil {
				t.Fatal("current quota or accounting hold authorized refresh")
			}
			var next controlprotocol.Desired
			f.s.Get("agent-desired", d.InstanceID, &next)
			if next.Identity() != d.Identity() {
				t.Fatal("blocked refresh replaced desired")
			}
		})
	}
}

func TestReviewServiceStageFailureDoesNotPoisonRecovery(t *testing.T) {
	for _, legacyFailure := range []bool{false, true} {
		t.Run(fmt.Sprint("legacy-failed-row-", legacyFailure), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "recovery.db")
			key := bytes.Repeat([]byte{19}, 32)
			db, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(httpapi.New(db, render.Default(), "012345678901234567890123456789012345", ""))
			defer func() { server.Close(); db.Close() }()
			f := fleetFixtureAt(t, db, server)
			en := f.post(t, "agent/enrollments", map[string]any{"nodeId": "host-fleet-b", "instanceId": "fleet-b", "expiresAt": time.Now().Add(time.Hour)}, 201)
			batch := createContinuousBatch(t, f, true)
			f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "a"}, 200)
			f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
			f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 1, "requestId": "b"}, 200)
			var d controlprotocol.Desired
			f.s.Get("agent-desired", "fleet-b", &d)
			var a controlprotocol.State
			f.s.Get("agent-observations", "fleet-a", &a)
			bad := a
			bad.RecoveryRequired = true
			f.s.Put("agent-observations", "fleet-a", bad)
			fact := liveServiceFact(d)
			fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
			serviceHeartbeatRequest(t, f, en["token"].(string), fact)
			var state map[string]any
			f.s.Get("agent-service-intents", "fleet-b", &state)
			state["nextAttemptAt"] = time.Now().Add(-time.Second).UTC()
			state["validationNotBefore"] = time.Now().Add(-time.Second).UTC()
			f.s.Put("agent-service-intents", "fleet-b", state)
			if code, _ := serviceHeartbeatRequest(t, f, en["token"].(string), fact); code != 409 {
				t.Fatalf("transient stage gate reported success: %d", code)
			}
			f.s.Get("agent-service-intents", "fleet-b", &state)
			if state["automaticAttempts"] != float64(0) {
				t.Fatal("transient failure consumed recovery budget")
			}
			if len(f.job(t, batch).Targets[1].Attempts) != 1 {
				t.Fatal("transient failure poisoned recovery request ID")
			}
			if legacyFailure {
				var record map[string]any
				f.s.Get("fleet-batches", batch, &record)
				b := record["batch"].(map[string]any)
				target := b["targets"].([]any)[1].(map[string]any)
				target["attempts"] = append(target["attempts"].([]any), fleet.Attempt{Number: 2, RequestID: "service-" + state["id"].(string) + "-1", Status: "failed", Code: "previous_stage_no_longer_current", QueuedAt: time.Now().UTC()})
				if err := f.s.Put("fleet-batches", batch, record); err != nil {
					t.Fatal(err)
				}
			}
			// A real reopen must not preserve a poisoned request or lose the budget.
			server.Close()
			db.Close()
			db, err = store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			server = httptest.NewServer(httpapi.New(db, render.Default(), "012345678901234567890123456789012345", ""))
			f.s = db
			f.srv = server
			f.s.Put("agent-observations", "fleet-a", a)
			clearServiceThrottle(t, f, "fleet-b")
			fact.Observed.ObservedAt = time.Now().UTC()
			var wg sync.WaitGroup
			for i := 0; i < 6; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); serviceHeartbeatRequest(t, f, en["token"].(string), fact) }()
			}
			wg.Wait()
			var got controlprotocol.Desired
			f.s.Get("agent-desired", "fleet-b", &got)
			f.s.Get("agent-service-intents", "fleet-b", &state)
			if got.Generation != d.Generation+1 || state["automaticAttempts"] != float64(1) || state["status"] != "recovery_queued" {
				t.Fatalf("recovery failed or duplicated after transient gate: %+v %+v", got.Identity(), state)
			}
			// Retrying the old observation, including after another reopen, cannot queue
			// another generation or count the successful request twice.
			if code, _ := serviceHeartbeatRequest(t, f, en["token"].(string), fact); code != 409 {
				t.Fatal("old absence replay accepted")
			}
			f.s.Get("agent-desired", "fleet-b", &got)
			if got.Generation != d.Generation+1 {
				t.Fatal("duplicate recovery allocated a generation")
			}
		})
	}
}

func TestContinuousServiceTerminalRecoveryChangeIsVisibleAndDoesNotConsumeBudget(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	fact := liveServiceFact(d)
	fact.Observed = controlprotocol.Observation{Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}
	serviceHeartbeatRequest(t, f, token, fact)
	var intent map[string]any
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	intent["nextAttemptAt"] = time.Now().Add(-time.Second).UTC()
	intent["validationNotBefore"] = time.Now().Add(-time.Second).UTC()
	f.s.Put("agent-service-intents", d.InstanceID, intent)
	var deployment map[string]any
	f.s.Get("server-deployments", f.in.DeploymentID, &deployment)
	deployment["ir"].(map[string]any)["topologyRevision"] = "new-reviewed-input-required"
	f.s.Put("server-deployments", f.in.DeploymentID, deployment)
	serviceHeartbeatRequest(t, f, token, fact)
	f.s.Get("agent-service-intents", d.InstanceID, &intent)
	if intent["status"] != "review_required" || intent["automaticAttempts"] != float64(0) {
		t.Fatalf("terminal recovery gate was hidden: %+v", intent)
	}
	clearServiceThrottle(t, f, d.InstanceID)
	serviceHeartbeatRequest(t, f, token, fact)
	var next controlprotocol.Desired
	f.s.Get("agent-desired", d.InstanceID, &next)
	if next.Identity() != d.Identity() {
		t.Fatal("terminal gate or duplicate queued a replacement")
	}
}
