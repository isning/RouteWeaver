package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"testing"
	"time"
)

type operatorTransport struct{}

func (operatorTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.Header.Set("Authorization", "Bearer 012345678901234567890123456789012345")
	return http.DefaultTransport.RoundTrip(copy)
}
func operatorClient() *http.Client { return &http.Client{Transport: operatorTransport{}} }
func TestServerPublicationIsScopedDesiredNotApplied(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	host := domain.Host{ID: "host1", Name: "Local fixture", Address: "127.0.0.1"}
	instance := domain.CoreInstance{ID: "core1", HostID: host.ID, AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}
	entry := domain.ManagedEndpoint{ID: "entry1", InstanceID: instance.ID, Name: "Fixture listener", Connection: domain.Connection{Host: "127.0.0.1", Port: 1080, Protocol: "socks", Username: "fixture-user", Password: "fixture-password"}}
	for _, item := range []struct {
		path string
		body any
	}{{"hosts", host}, {"core-instances", instance}, {"managed-endpoints", entry}} {
		code, _, raw := req(t, admin, "POST", srv.URL+"/api/"+item.path, "", item.body)
		if code != 200 {
			t.Fatalf("inventory %s: %d %s", item.path, code, raw)
		}
	}
	enroll := func() (agent.Scope, string) {
		code, out, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
		if code != 201 {
			t.Fatalf("enroll %d %s", code, raw)
		}
		var scope agent.Scope
		b, _ := json.Marshal(out["scope"])
		json.Unmarshal(b, &scope)
		return scope, out["token"].(string)
	}
	scope, token := enroll()
	transport, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: token, Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	desired, e := transport.ReceiveDesired(context.Background(), scope, 0)
	if e != nil || desired != nil {
		t.Fatalf("unpublished desired: %+v %v", desired, e)
	}
	ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment1", TopologyRevision: "topology1", Programs: []domain.ServerProgram{{Instance: instance, Listener: entry}}}
	code, _, raw := req(t, admin, "POST", srv.URL+"/api/server-deployments", "", map[string]any{"id": ir.ID, "name": "Local deployment", "ir": ir})
	if code != 200 {
		t.Fatalf("save %d %s", code, raw)
	}
	opened := openServerDraft(t, admin, srv.URL+"/api/server-deployments/deployment1")
	code, validation, raw := validateOpenedServer(t, admin, srv.URL+"/api/server-deployments/deployment1", opened["revisionToken"].(string))
	if code != 200 || validation["valid"] != true {
		t.Fatalf("validate %d %s", code, raw)
	}
	code, out, raw := req(t, admin, "POST", srv.URL+"/api/server-deployments/deployment1/publish", "", map[string]any{"operationId": "publish-agent", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": validation["fingerprint"]})
	if code != 200 || out["status"] != "publication-accepted" || out["nativeChecked"] != false {
		t.Fatalf("queue %d %s", code, raw)
	}
	desired, e = transport.ReceiveDesired(context.Background(), scope, 0)
	if e != nil || desired == nil || desired.Generation != 1 {
		t.Fatalf("receive %+v %v", desired, e)
	}
	identity := desired.Identity()
	if e = transport.ReportObservation(context.Background(), scope, agent.State{HighestAccepted: 1, Desired: &identity, Phase: agent.Accepted}); e != nil {
		t.Fatal(e)
	}
	code, out, raw = req(t, admin, "GET", srv.URL+"/api/agent/instances/core1/state", "", nil)
	if code != 200 || out["phase"] != agent.Accepted {
		t.Fatalf("state %d %s", code, raw)
	}
	spoof := identity
	spoof.OperationID = "different-operation"
	if e = transport.ReportObservation(context.Background(), scope, agent.State{Desired: &spoof, Phase: agent.Accepted}); e == nil {
		t.Fatal("same generation with different identity accepted")
	}
	enroll()
	if _, e = transport.ReceiveDesired(context.Background(), scope, 0); e == nil {
		t.Fatal("superseded enrollment can still fetch desired")
	}
	if e = transport.ReportObservation(context.Background(), scope, agent.State{Desired: &identity, Phase: agent.Accepted}); e == nil {
		t.Fatal("superseded enrollment can still report observations")
	}
}

func TestAgentMeterSpoolBaselineRecoveryAndQuotaUseOneLedger(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			s, srv := makeServer(t)
			user := inviteClient(t, s, srv, "meter-owner")
			admin := operatorClient()
			instance := domain.CoreInstance{ID: "meter-core", HostID: "meter-host", AdapterID: render.ServerAdapterSingBox, Version: render.SingBoxVersion}
			if e := s.Put("core-instances", instance.ID, instance); e != nil {
				t.Fatal(e)
			}
			code, out, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": instance.HostID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
			if code != 201 {
				t.Fatalf("enroll %d %s", code, raw)
			}
			var scope agent.Scope
			b, _ := json.Marshal(out["scope"])
			if e := json.Unmarshal(b, &scope); e != nil {
				t.Fatal(e)
			}
			transport, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: out["token"].(string), Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
			if e != nil {
				t.Fatal(e)
			}
			defer transport.Close()
			binding := map[string]any{"id": "binding", "subjectId": "native-user", "userId": user.id, "routeId": "r", "policyRevision": "policy1", "cycleId": "cycle1", "measurementLayer": "entry_payload", "rateId": "default-1x"}
			if code, _, raw = req(t, admin, "POST", srv.URL+"/api/agent/instances/"+instance.ID+"/meter-bindings", "", binding); code != 201 {
				t.Fatalf("binding %d %s", code, raw)
			}
			spool, e := agent.OpenMeterSpool(filepath.Join(t.TempDir(), "spool"), scope, "stream1")
			if e != nil {
				t.Fatal(e)
			}
			defer spool.Close()
			sample := agent.MeterSample{SampleID: "first", CounterEpoch: "boot1", SubjectID: "native-user", RouteID: "r", PolicyRevision: "policy1", CycleID: "cycle1", MeasurementLayer: "entry_payload", CumulativeBytes: 110, ObservedAt: time.Now().Add(-time.Minute)}
			batch, e := spool.Enqueue([]agent.MeterSample{sample})
			if e != nil {
				t.Fatal(e)
			}
			if legacy {
				stored := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest, Samples: []store.CounterSample{{SampleID: sample.SampleID, CounterEpoch: sample.CounterEpoch, SubjectID: sample.SubjectID, RouteID: sample.RouteID, PolicyRevision: sample.PolicyRevision, CycleID: sample.CycleID, MeasurementLayer: sample.MeasurementLayer, CumulativeBytes: sample.CumulativeBytes, ObservedAt: sample.ObservedAt}}}
				receiptID := fmt.Sprintf("%s:%s:%s:%d", scope.InstanceID, scope.EnrollmentEpoch, batch.StreamEpoch, batch.Sequence)
				original, err := json.Marshal(batch)
				if err != nil {
					t.Fatal(err)
				}
				pending := store.PendingCounterBatch{ReceiptID: receiptID, Batch: stored, Original: original, Reason: "legacy missing baseline", CreatedAt: time.Now().UTC()}
				for _, kind := range []string{"meter-pending", "meter-pending-history"} {
					if err = s.Put(kind, receiptID, pending); err != nil {
						t.Fatal(err)
					}
				}
				if err = s.Put("accounting-holds", user.id+":"+receiptID, store.AccountingHold{UserID: user.id, ReceiptID: receiptID, Reason: pending.Reason, CreatedAt: pending.CreatedAt}); err != nil {
					t.Fatal(err)
				}
				code, out, raw = req(t, user.c, "GET", srv.URL+"/api/me/overview", "", nil)
				if code != 200 || out["status"] != "accounting-pending" {
					t.Fatalf("legacy fixture %d %s", code, raw)
				}
			}
			// No administrator action is required: a valid first observation is ACKed.
			command := map[string]string{"receiptId": "not-authorized", "expectedDigest": batch.Digest, "reason": "not allowed"}
			endpoint := srv.URL + "/api/agent/instances/" + instance.ID + "/meter-baseline"
			if code, _, raw = req(t, user.c, "POST", endpoint, user.csrf, command); code != 403 {
				t.Fatalf("tenant baseline privilege %d %s", code, raw)
			}
			receipt, e := transport.SendMeterBatch(context.Background(), batch)
			if e != nil {
				t.Fatal(e)
			}
			if e = spool.Ack(receipt); e != nil {
				t.Fatal(e)
			}
			if _, e = transport.SendMeterBatch(context.Background(), batch); e != nil {
				t.Fatalf("accepted replay %v", e)
			}
			code, out, raw = req(t, user.c, "GET", srv.URL+"/api/me/overview", "", nil)
			if code != 200 || out["status"] != "active" {
				t.Fatalf("automatic overview %d %s", code, raw)
			}
			if out["usage"].(map[string]any)["rawBytes"] != float64(0) {
				t.Fatalf("unknown history charged %s", raw)
			}
			code, _, raw = req(t, admin, "GET", srv.URL+"/api/agent/instances/"+instance.ID+"/accounting-pending", "", nil)
			var pending []any
			if code != 200 || json.Unmarshal([]byte(raw), &pending) != nil || len(pending) != 0 {
				t.Fatalf("manual pending remains %d %s", code, raw)
			}
			sample.SampleID = "second"
			sample.CumulativeBytes = 150
			sample.ObservedAt = sample.ObservedAt.Add(time.Second)
			batch, e = spool.Enqueue([]agent.MeterSample{sample})
			if e != nil {
				t.Fatal(e)
			}
			receipt, e = transport.SendMeterBatch(context.Background(), batch)
			if e != nil {
				t.Fatal(e)
			}
			if e = spool.Ack(receipt); e != nil {
				t.Fatal(e)
			}
			code, out, raw = req(t, user.c, "GET", srv.URL+"/api/me/overview", "", nil)
			if code != 200 || out["status"] != "active" {
				t.Fatalf("resolved overview %d %s", code, raw)
			}
			usage := out["usage"].(map[string]any)
			if usage["rawBytes"] != float64(40) || usage["weightedBytes"] != float64(40) || usage["providerBytes"] != float64(0) {
				t.Fatalf("wrong canonical quota %s", raw)
			}
			if len(spool.Pending()) != 0 {
				t.Fatal("acknowledged batches retained as pending")
			}
		})
	}
}
