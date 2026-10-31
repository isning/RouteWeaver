package httpapi

import (
	"fmt"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/fleet"
	"time"
)

// A successful historical action is not a perpetual rollout gate. Advancing a
// stage rechecks the previous stages against current exact desired/observation
// records and leases, then fences those records in the queue transaction.
func (h *server) fleetStageCurrent(record fleetRecord, stage int, p *preparedFleet) error {
	for _, target := range record.Batch.Targets {
		if target.Stage >= stage {
			continue
		}
		if len(target.Attempts) == 0 {
			return fmt.Errorf("previous stage has no observed operation")
		}
		attempt := target.Attempts[len(target.Attempts)-1]
		if attempt.Identity == nil {
			return fmt.Errorf("previous stage has no accepted operation")
		}
		var desired controlprotocol.Desired
		if e := h.fleetRead(p, "agent-desired", target.InstanceID, &desired, false); e != nil {
			return e
		}
		if desired.Identity() != *attempt.Identity {
			return fmt.Errorf("previous stage was superseded; review a new batch before continuing")
		}
		var state controlprotocol.State
		if e := h.fleetRead(p, "agent-observations", target.InstanceID, &state, false); e != nil {
			return e
		}
		if fleet.Outcome(record.Batch.Action, attempt, &state, time.Now().UTC()).Status != "succeeded" {
			return fmt.Errorf("previous stage is no longer observed successful; reconcile its agent before continuing")
		}
		if record.Batch.Action != "stop" && record.Batch.Action != "install" && !time.Now().Before(desired.Lease.ExpiresAt) {
			return fmt.Errorf("previous stage policy lease expired; review a new batch before continuing")
		}
	}
	return nil
}
