package diagnostics_test

import (
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/diagnostics"
	"testing"
	"time"
)

func TestRequestedDiagnosticHasExplicitDirectionCostAndScope(t *testing.T) {
	now := time.Now().UTC()
	target := diagnostics.Target{ID: "target", Name: "Authorized fixture", NodeID: "node", URL: "https://example.com/download", Methods: []string{"download"}}
	scope := controlprotocol.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	j, e := diagnostics.NewJob(diagnostics.Request{ID: "job", TargetID: "target", InstanceID: "core", Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2}, target, scope, "operator", now)
	if e != nil {
		t.Fatal(e)
	}
	if j.Direction != "target_to_node" || j.EstimatedMaxBytes != 4096 || j.Status != "queued" || j.Result != nil {
		t.Fatalf("untruthful requested diagnostic %+v", j)
	}
	wrong := scope
	wrong.NodeID = "other"
	if _, e = diagnostics.NewJob(j.Request, target, wrong, "operator", now); e == nil {
		t.Fatal("foreign target accepted")
	}
	j.Request.MaxBytes = diagnostics.MaxPayloadBytes + 1
	if _, e = diagnostics.NewJob(j.Request, target, scope, "operator", now); e == nil {
		t.Fatal("unbounded bytes accepted")
	}
}
func TestDiagnosticResultsCannotClaimSuccessWithoutCompletedPayload(t *testing.T) {
	now := time.Now().UTC()
	scope := controlprotocol.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	j, e := diagnostics.NewJob(diagnostics.Request{ID: "job", TargetID: "target", InstanceID: "core", Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2}, diagnostics.Target{ID: "target", Name: "Target", NodeID: "node", URL: "https://example.com/", Methods: []string{"download"}}, scope, "operator", now)
	if e != nil {
		t.Fatal(e)
	}
	j.AttemptID = "attempt"
	j.Status = "running"
	r := diagnostics.Report{JobID: j.ID, Scope: scope, AttemptID: j.AttemptID, Result: diagnostics.Result{Status: "succeeded", Phase: "complete", Code: "completed", CostKnown: true, HTTPStatus: 200, StartedAt: now, FinishedAt: now.Add(time.Second), DurationMS: 1000}}
	if r.Validate(j) == nil {
		t.Fatal("zero transferred bytes claimed success")
	}
	r.Result.BytesReceived = 4096
	rate := 4096.0
	r.Result.BytesPerSecond = &rate
	if e = r.Validate(j); e != nil {
		t.Fatalf("real measured transfer rejected %v", e)
	}
	fake := 1000000.0
	r.Result.BytesPerSecond = &fake
	if r.Validate(j) == nil {
		t.Fatal("fabricated rate accepted")
	}
}
