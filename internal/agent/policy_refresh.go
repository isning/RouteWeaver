package agent

import (
	"context"
	"errors"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

// ServiceHeartbeat observes under the same lock as native mutation. Known
// absence may request a new CP generation; it is never lease-renewal evidence.
func (r *Reconciler) ServiceHeartbeat(ctx context.Context) (controlprotocol.ServiceHeartbeat, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.disk.Payload == nil {
		return controlprotocol.ServiceHeartbeat{}, errors.New("no active service intent")
	}
	_, _ = r.recoverLocked(ctx)
	if r.disk.State.RecoveryRequired {
		return controlprotocol.ServiceHeartbeat{}, ErrUnknownRuntime
	}
	_, obs, err := r.observeRuntimeLocked(ctx, *r.disk.Payload)
	if err != nil || !obs.Known || !obs.Quiescent {
		return controlprotocol.ServiceHeartbeat{}, ErrUnknownRuntime
	}
	return controlprotocol.ServiceHeartbeat{Desired: r.disk.Payload.Identity(), Observed: obs, PolicyIssuedAt: r.effectivePolicy().Lease.IssuedAt, ServiceActive: true}, nil
}

// ApplyPolicyRefresh never stages, launches, adopts, or replays a native command.
// Authorization must still be valid when the exact response arrives. A late
// refresh cannot revive an expired/restricted/unknown runtime.
func (r *Reconciler) ApplyPolicyRefresh(ctx context.Context, update controlprotocol.PolicyRefresh) (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	if r.disk.Payload == nil || r.disk.LastValid == nil || update.Identity != r.disk.Payload.Identity() || update.Identity != r.disk.LastValid.Identity() || !domain.ValidID(update.IntentID) || update.Sequence == 0 {
		return r.out(errors.New("policy refresh identity mismatch"))
	}
	if _, err := r.recoverLocked(ctx); err != nil {
		return r.out(err)
	}
	if r.disk.State.RecoveryRequired || r.disk.State.Phase != ObservedConformant || r.disk.State.Observed == nil || r.disk.State.Observed.Identity != update.Identity {
		return r.out(ErrUnknownRuntime)
	}
	if err := r.gate(r.effectivePolicy()); err != nil {
		return r.out(err)
	}
	if previous := r.disk.PolicyRefresh; previous != nil {
		if *previous == update {
			return r.out(nil)
		}
		if previous.IntentID == update.IntentID && update.Sequence <= previous.Sequence {
			return r.out(errors.New("stale policy refresh sequence"))
		}
		if previous.Identity == update.Identity && previous.IntentID != update.IntentID {
			return r.out(errors.New("service intent changed without new generation"))
		}
	}
	if update.Lease.Revision != r.effectivePolicy().Lease.Revision || !update.Lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) || leaseDecision(update.Lease, r.options.Now(), r.disk.LastWallTime, r.options.MaxLease) != "allowed" {
		return r.out(ErrLeaseBlocked)
	}
	oldRefresh, oldLatest, oldHigh := r.disk.PolicyRefresh, r.disk.LatestPolicy, r.disk.PolicyIssuedHighWater
	r.disk.PolicyRefresh = &update
	lease := update.Lease
	r.disk.LatestPolicy = &lease
	r.disk.PolicyIssuedHighWater = lease.IssuedAt
	if err := r.persist(); err != nil {
		r.disk.PolicyRefresh, r.disk.LatestPolicy, r.disk.PolicyIssuedHighWater = oldRefresh, oldLatest, oldHigh
		return r.out(err)
	}
	return r.out(nil)
}
func (r *Reconciler) refreshedPolicy(d Desired) Desired {
	if update := r.disk.PolicyRefresh; update != nil && update.Identity == d.Identity() {
		d.Lease = update.Lease
	}
	return d
}
