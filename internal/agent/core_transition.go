package agent

import (
	"context"
	"errors"
)

func (r *Reconciler) validateTransitionLocked(d Desired) error {
	if d.Action == "install" || d.Action == "stop" {
		return nil
	}
	if previousPolicy := r.disk.LatestPolicy; previousPolicy != nil {
		now := r.options.Now()
		if leaseDecision(*previousPolicy, now, r.disk.LastWallTime, r.options.MaxLease) != "allowed" && leaseDecision(d.Lease, now, r.disk.LastWallTime, r.options.MaxLease) == "allowed" && !d.Lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) {
			return errors.New("restoring access requires a newly issued current policy lease after the accepted denial")
		}
	}
	previous := r.disk.LastValid
	if previous == nil && r.disk.Payload != nil && r.disk.Payload.Action != "install" {
		previous = r.disk.Payload
	}
	if previous == nil {
		if d.Transition != nil {
			return errors.New("core transition has no previously accepted runtime identity")
		}
		return nil
	}
	changed := previous.AdapterID != d.AdapterID || previous.CoreVersion != d.CoreVersion
	if changed && d.Transition == nil {
		return errors.New("adapter migration requires an explicit migration procedure")
	}
	if d.Transition != nil && d.Lease.IssuedAt.Before(r.disk.PolicyIssuedHighWater) {
		return errors.New("core transition requires a fresh current policy lease, not historical permissions")
	}
	if d.Transition != nil && (!changed || d.Transition.From != previous.Identity()) {
		return errors.New("core transition source is stale or differs from the previously active identity")
	}
	return nil
}

// The old adapter retains ownership checks; the new adapter never receives
// permission to signal a process associated with another executable identity.
func (r *Reconciler) stopTransitionSourceLocked(ctx context.Context, d Desired) error {
	source := d.Transition.From
	old, err := r.registry.Get(source.AdapterID, source.CoreVersion)
	if err != nil {
		return err
	}
	observed, err := old.Observe(ctx, r.root)
	if err != nil || !observed.Known || !observed.Quiescent || (observed.Generation != 0 && observed.Identity != source) {
		return ErrUnknownRuntime
	}
	if observed.Generation != 0 {
		restrictor, ok := old.(PolicyRestrictor)
		if !ok {
			return ErrUnsupportedActivation
		}
		if err = restrictor.Restrict(ctx, r.root); err != nil {
			return err
		}
	}
	observed, err = old.Observe(ctx, r.root)
	if err != nil || !observed.Known || !observed.Quiescent || observed.Generation != 0 {
		return ErrUnknownRuntime
	}
	r.disk.State.Observed = nil
	return r.persist()
}

// observeRuntimeLocked tries only the explicitly known target and previous
// identity. It never weakens either adapter's executable/process ownership test.
func (r *Reconciler) observeRuntimeLocked(ctx context.Context, d Desired) (Adapter, Observation, error) {
	if (d.Action == "install" || d.Action == "stop") && r.disk.LastValid != nil {
		d = *r.disk.LastValid
	}
	target, err := r.registry.Get(d.AdapterID, d.CoreVersion)
	if err != nil {
		// A download can fail before the target adapter is registered. The
		// durable empty stage proves this candidate never reached activation;
		// do not let its absence prevent restricting the actual old runtime.
		// After staging, a missing target is uncertain and must stay unknown.
		if r.disk.Stage == "" && r.disk.LastValid != nil {
			previous := r.disk.LastValid
			old, oldErr := r.registry.Get(previous.AdapterID, previous.CoreVersion)
			if oldErr != nil {
				return nil, Observation{}, oldErr
			}
			observed, oldErr := old.Observe(ctx, r.root)
			if oldErr == nil && observed.Known && observed.Quiescent && (observed.Generation == 0 || observed.Identity == previous.Identity()) {
				return old, observed, nil
			}
			return nil, Observation{}, ErrUnknownRuntime
		}
		return nil, Observation{}, err
	}
	observed, targetErr := target.Observe(ctx, r.root)
	if targetErr == nil && observed.Known && observed.Quiescent && observed.Identity == d.Identity() {
		return target, observed, nil
	}
	previous := r.disk.LastValid
	if previous == nil || previous.AdapterID == d.AdapterID && previous.CoreVersion == d.CoreVersion {
		return target, observed, targetErr
	}
	old, err := r.registry.Get(previous.AdapterID, previous.CoreVersion)
	if err != nil {
		return nil, Observation{}, err
	}
	oldObservation, oldErr := old.Observe(ctx, r.root)
	if oldErr == nil && oldObservation.Known && oldObservation.Quiescent && oldObservation.Identity == previous.Identity() {
		if targetErr == nil && observed.Known && observed.Generation != 0 && observed.Identity != oldObservation.Identity {
			return nil, Observation{}, ErrUnknownRuntime
		}
		return old, oldObservation, nil
	}
	if targetErr == nil && observed.Known && observed.Quiescent && observed.Generation == 0 && oldErr == nil && oldObservation.Known && oldObservation.Quiescent && oldObservation.Generation == 0 {
		return target, observed, nil
	}
	return nil, Observation{}, ErrUnknownRuntime
}
