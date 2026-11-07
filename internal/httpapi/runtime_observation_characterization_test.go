package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/httpapi"
	"testing"
	"time"
)

// This diagnostic characterizes the current accepted replay behavior, not the
// desired ordering contract. It deliberately sends synthetic runtime facts over
// the real authenticated HTTP/store path. It does not run a native runtime or
// reproduce the serialized driver's timeout/server-continuation interleaving.
// Keep it on the diagnostic branch until an ordering/cutover design is reviewed;
// a future ordering fix should replace this expectation, not preserve the bug.
func TestRuntimeObservationCharacterizationSameGenerationReplayReplacesCurrent(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	batchID := f.create(t)
	f.post(t, "admin/fleet-batches/"+batchID+"/execute", map[string]any{"stage": 0, "requestId": "runtime-order-characterization"}, http.StatusOK)
	var enrollment httpapi.Enrollment
	if err := f.s.Get("instance-enrollments", "fleet-a", &enrollment); err != nil {
		t.Fatal(err)
	}
	transport := f.transports["fleet-a"]
	desired, err := transport.ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if err != nil || desired == nil {
		t.Fatalf("receive desired: %v %v", desired, err)
	}
	identity := desired.Identity()
	conformant := controlprotocol.State{
		HighestAccepted: desired.Generation,
		Desired:         &identity,
		Observed: &controlprotocol.Observation{
			Identity:   identity,
			Known:      true,
			Quiescent:  true,
			Evidence:   "synthetic characterization observation",
			ObservedAt: time.Now().UTC(),
		},
		LastKnownValid: &identity,
		Phase:          controlprotocol.ObservedConformant,
		NativeChecked:  true,
	}
	// Recover reports this phase/code with no observed runtime after a previously
	// conformant runtime disappears. The desired identity remains unchanged.
	stopped := controlprotocol.State{
		HighestAccepted: desired.Generation,
		Desired:         &identity,
		LastKnownValid:  &identity,
		Phase:           controlprotocol.ApplyFailed,
		Code:            "runtime_not_running",
		NativeChecked:   true,
	}
	assertCurrent := func(want controlprotocol.State) {
		t.Helper()
		code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/fleet-a/state", "", nil)
		if code != http.StatusOK {
			t.Fatalf("read current state: HTTP %d %s", code, raw)
		}
		var view struct {
			Phase   string                   `json:"phase"`
			Desired controlprotocol.Identity `json:"desired"`
			State   controlprotocol.State    `json:"state"`
		}
		if err := json.Unmarshal([]byte(raw), &view); err != nil {
			t.Fatal(err)
		}
		if view.Phase != want.Phase || view.Desired != identity || !reflect.DeepEqual(view.State, want) {
			t.Fatalf("current state differs from report: got %+v want %+v", view, want)
		}
	}
	assertArchive := func() {
		t.Helper()
		var archived controlprotocol.State
		if err := f.s.Get("agent-operation-observations", desired.OperationID, &archived); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(archived, conformant) {
			t.Fatalf("first successful operation observation changed: %+v", archived)
		}
		job := f.job(t, batchID)
		if len(job.Targets) != 1 || job.Targets[0].Status != "succeeded" {
			t.Fatalf("historical target outcome changed: %+v", job)
		}
	}
	for _, report := range []controlprotocol.State{conformant, stopped, conformant} {
		// The third send reuses the exact first State, including ObservedAt.
		// HTTPTransport serializes it with the same payload-derived retry key.
		if err := transport.ReportObservation(context.Background(), desired.Scope, report); err != nil {
			t.Fatal(err)
		}
		assertCurrent(report)
		assertArchive()
	}

	// The characterization does not relax existing desired-generation checks.
	wrongIdentity := identity
	wrongIdentity.Generation++
	wrongGeneration := stopped
	wrongGeneration.Desired = &wrongIdentity
	err = transport.ReportObservation(context.Background(), desired.Scope, wrongGeneration)
	var transportErr *agent.TransportError
	if !errors.As(err, &transportErr) || transportErr.Status != http.StatusConflict {
		t.Fatalf("mismatched generation: want HTTP 409, got %v", err)
	}
	assertCurrent(conformant)
	assertArchive()

	// Re-enrollment must still reject the old authenticated sender, even when its
	// replay exactly matches the persisted desired identity and successful state.
	f.post(t, "agent/enrollments", map[string]any{"nodeId": desired.NodeID, "instanceId": desired.InstanceID, "expiresAt": time.Now().Add(time.Hour)}, http.StatusCreated)
	err = transport.ReportObservation(context.Background(), desired.Scope, conformant)
	transportErr = nil
	if !errors.As(err, &transportErr) || transportErr.Status != http.StatusUnauthorized {
		t.Fatalf("superseded enrollment: want HTTP 401, got %v", err)
	}
	assertCurrent(conformant)
	assertArchive()
}
