package agent

import (
	"errors"
	"math"
)

// ObservationReport snapshots current facts with a durable enrollment-scoped
// sequence before transport. Gaps are safe; reuse after restart is not. Callers
// must retry the returned snapshot unchanged, never stamp an older saved state.
func (r *Reconciler) ObservationReport() (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return State{}, errors.New("agent is closed")
	}
	if r.disk.ReportSequence == math.MaxUint64 {
		return State{}, errors.New("observation sequence exhausted; reenrollment required")
	}
	r.disk.ReportSequence++
	if err := r.persist(); err != nil {
		return State{}, err
	}
	report := copyState(r.disk.State)
	report.ReportSequence = r.disk.ReportSequence
	return report, nil
}
