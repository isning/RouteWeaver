package httpapi

import (
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/fleet"
	"routeweaver/internal/store"
	"time"
)

// Current state follows every valid report; the operation archive retains its
// first exact success so a later process stop cannot rewrite rollout history.
func (h *server) recordAgentObservation(desired controlprotocol.Desired, enrollment Enrollment, state controlprotocol.State) error {
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
	return h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "agent-desired", ID: desired.InstanceID, Expected: desired}, {Kind: "instance-enrollments", ID: desired.InstanceID, Expected: enrollment}, {Kind: "agent-operation-observations", ID: desired.OperationID, Expected: expected}}, writes)
}
