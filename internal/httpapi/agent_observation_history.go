package httpapi

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/fleet"
	"routeweaver/internal/store"
	"time"
)

// Current state follows ordered reports; the operation archive retains its
// first exact success so a later process stop cannot rewrite rollout history.
func (h *server) recordAgentObservation(desired controlprotocol.Desired, enrollment Enrollment, state controlprotocol.State) error {
	var current controlprotocol.State
	var currentRaw json.RawMessage
	var expectedCurrent any
	if err := h.s.Get("agent-observations", desired.InstanceID, &currentRaw); err == nil {
		if err := json.Unmarshal(currentRaw, &current); err != nil {
			return err
		}
		expectedCurrent = currentRaw
	} else if err != store.ErrNotFound {
		return err
	}
	compares := []store.RecordCompare{{Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}, {Kind: "instance-enrollments", ID: desired.InstanceID, Expected: enrollment}, {Kind: "agent-observations", ID: desired.InstanceID, Expected: expectedCurrent}}
	if current.Desired != nil && current.Desired.Scope == enrollment.Scope && current.ReportSequence != 0 {
		if state.ReportSequence < current.ReportSequence {
			return store.ErrConflict
		}
		if state.ReportSequence == current.ReportSequence {
			if !reflect.DeepEqual(state, current) {
				return store.ErrConflict
			}
			// An exact retry neither refreshes receipt time nor rewrites history.
			return h.s.CompareAndPutRecords(compares, nil)
		}
	}
	var archived controlprotocol.State
	e := h.s.Get("agent-operation-observations", desired.OperationID, &archived)
	if e != nil && e != store.ErrNotFound {
		return e
	}
	var expected any
	if e == nil {
		expected = archived
	}
	retained := state
	identity := desired.Identity()
	success := fleet.Outcome(desired.Action, fleet.Attempt{Identity: &identity, CoreReleaseID: desired.CoreReleaseID}, &archived, time.Now().UTC()).Status == "succeeded"
	if success {
		retained = archived
	}
	writes := []store.RecordWrite{{Kind: "agent-observations", ID: desired.InstanceID, Value: state}, {Kind: "agent-operation-observations", ID: desired.OperationID, Value: retained}}
	if !success {
		writes = append(writes, store.RecordWrite{Kind: "agent-operation-received", ID: desired.OperationID, Value: time.Now().UTC()})
	}
	compares = append(compares, store.RecordCompare{Kind: "agent-operation-observations", ID: desired.OperationID, Expected: expected})
	return h.s.CompareAndPutRecords(compares, writes)
}
