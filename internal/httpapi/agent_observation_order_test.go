package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/httpapi"
	"testing"
	"time"
)

func TestRuntimeObservationRejectsOutOfOrderReports(t *testing.T) {
	f := newFleetFixture(t)
	batch := f.create(t)
	f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "ordered-reports"}, 200)
	var enrollment httpapi.Enrollment
	if err := f.s.Get("instance-enrollments", "fleet-a", &enrollment); err != nil {
		t.Fatal(err)
	}
	tr := f.transports["fleet-a"]
	desired, err := tr.ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if err != nil || desired == nil {
		t.Fatalf("desired: %v %v", desired, err)
	}
	identity := desired.Identity()
	send := func(state controlprotocol.State) error {
		return tr.ReportObservation(context.Background(), enrollment.Scope, state)
	}
	current := func() controlprotocol.State {
		t.Helper()
		code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/fleet-a/state", "", nil)
		if code != 200 {
			t.Fatalf("state %d: %s", code, raw)
		}
		var out struct {
			State controlprotocol.State `json:"state"`
		}
		if err := json.Unmarshal([]byte(raw), &out); err != nil {
			t.Fatal(err)
		}
		return out.State
	}
	active := controlprotocol.State{ReportSequence: 1, HighestAccepted: desired.Generation, Desired: &identity, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}}
	legacyInitial := active
	legacyInitial.ReportSequence = 0
	if err := send(legacyInitial); err != nil {
		t.Fatalf("legacy report before sequence upgrade: %v", err)
	}
	if err := send(active); err != nil {
		t.Fatal(err)
	}
	stopped := active
	stopped.ReportSequence = 2
	stopped.Phase, stopped.Code, stopped.Observed = "stopped", "local_session_stopped", nil
	if err := send(stopped); err != nil {
		t.Fatal(err)
	}
	if err := send(active); err == nil {
		t.Fatal("delayed same-generation active report overwrote the later stop")
	}
	if got := current(); got.Phase != "stopped" || got.ReportSequence != 2 {
		t.Fatalf("stale report changed state: %+v", got)
	}
	if err := send(stopped); err != nil {
		t.Fatalf("exact lost-response retry: %v", err)
	}
	conflict := stopped
	conflict.Phase = controlprotocol.Unknown
	if err := send(conflict); err == nil {
		t.Fatal("same sequence accepted different facts")
	}
	legacy := active
	legacy.ReportSequence = 0
	if err := send(legacy); err == nil {
		t.Fatal("unsequenced report downgraded ordered instance")
	}
	later := stopped
	later.ReportSequence = 3
	later.Phase = controlprotocol.Unknown
	if err := send(later); err != nil {
		t.Fatal(err)
	}
	if got := current(); got.Phase != controlprotocol.Unknown || got.ReportSequence != 3 {
		t.Fatalf("newer nonconformant report lost: %+v", got)
	}

	// Once history retains success, concurrent reports still need a current-state
	// compare. The immutable success archive alone cannot serialize later facts.
	const writers = 12
	results := make(chan uint64, writers)
	start := make(chan struct{})
	for i := uint64(4); i < 4+writers; i++ {
		go func(sequence uint64) {
			report := later
			report.ReportSequence = sequence
			report.Code = fmt.Sprintf("report_%d", sequence)
			<-start
			if err := send(report); err != nil {
				results <- 0
			} else {
				results <- sequence
			}
		}(i)
	}
	close(start)
	highest := uint64(3)
	for range writers {
		if sequence := <-results; sequence > highest {
			highest = sequence
		}
	}
	if got := current(); got.ReportSequence != highest {
		t.Fatalf("concurrent writer regressed accepted sequence: got %d, max accepted %d", got.ReportSequence, highest)
	}
	job := f.job(t, batch)
	if job.Targets[0].Status != "succeeded" {
		t.Fatalf("current runtime regression rewrote historic success: %+v", job.Targets[0])
	}
}
