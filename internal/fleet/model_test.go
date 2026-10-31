package fleet_test

import (
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/fleet"
	"testing"
	"time"
)

func TestBatchOutcomeRequiresExactObservedOperationAndStageSuccess(t *testing.T) {
	id := controlprotocol.Identity{Generation: 2, OperationID: "op2", RevisionID: "rev2", Digest: "digest"}
	attempt := fleet.Attempt{Identity: &id, Status: "queued", LeaseExpiresAt: time.Now().Add(time.Hour)}
	observation := controlprotocol.State{Desired: &id, NativeChecked: true, Phase: controlprotocol.ObservedConformant, Observed: &controlprotocol.Observation{Identity: id, Known: true, Quiescent: true}}
	if got := fleet.Outcome("configure", attempt, &observation, time.Now()); got.Status != "succeeded" {
		t.Fatalf("exact evidence not accepted: %+v", got)
	}
	observation.Observed.OperationID = "other"
	if got := fleet.Outcome("configure", attempt, &observation, time.Now()); got.Status == "succeeded" {
		t.Fatal("mismatched operation falsely succeeded")
	}
	observation.Observed = nil
	observation.Phase = controlprotocol.Blocked
	observation.Code = "policy_restricted"
	if got := fleet.Outcome("stop", attempt, &observation, time.Now()); got.Status != "succeeded" {
		t.Fatalf("observed stopped operation not accepted: %+v", got)
	}
	if got := fleet.Outcome("configure", attempt, &observation, time.Now()); got.Status == "succeeded" {
		t.Fatal("denied runtime claimed configured")
	}
	if got := fleet.Outcome("configure", attempt, nil, time.Now()); got.Status != "queued" {
		t.Fatal("disconnect is not success")
	}
	targets := []fleet.Target{{InstanceID: "first", Stage: 0, Status: "queued"}, {InstanceID: "next", Stage: 1, Status: "planned"}}
	if fleet.CanExecuteStage(targets, 1) == nil {
		t.Fatal("next stage passed without observation")
	}
	targets[0].Status = "succeeded"
	if err := fleet.CanExecuteStage(targets, 1); err != nil {
		t.Fatal(err)
	}
}

func TestExpiredUnobservedAttemptIsUnknownNotRetryableFailure(t *testing.T) {
	now := time.Now()
	id := controlprotocol.Identity{Generation: 1, OperationID: "first"}
	a := fleet.Attempt{Identity: &id, Status: "queued", LeaseExpiresAt: now.Add(-time.Second)}
	got := fleet.Outcome("configure", a, nil, now)
	if got.Status != "unknown" || got.Code != "lease_expired_without_observation_reconnect_agent" {
		t.Fatalf("missing expiry recovery: %+v", got)
	}
	later := id
	later.Generation = 2
	got = fleet.Outcome("configure", a, &controlprotocol.State{Desired: &later}, now)
	if got.Status != "superseded" {
		t.Fatalf("supersession not distinguished: %+v", got)
	}
	state := controlprotocol.State{Desired: &id, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: id, Known: true, Quiescent: true}}
	if got = fleet.Outcome("configure", a, &state, now); got.Status != "succeeded" {
		t.Fatal("expiry overwrote known historic success")
	}
}
