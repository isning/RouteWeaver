package agent

import (
	"context"
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/privateipc"
	"time"
)

// The pipe session pins a process to the exact artifacts which created it. A
// concurrent activation closes this old channel; it cannot redirect a probe to
// a new process after the reconciliation lock has been released.
func pipeControlForIdentity(root string, expected Identity) (*privateipc.ControlClient, error) {
	b, e := pipeBroker(root)
	if e != nil {
		return nil, e
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.session == nil || b.session.identity != expected {
		return nil, errors.New("managed process identity changed")
	}
	return b.session.control, nil
}
func (r *Reconciler) diagnosticControl(ctx context.Context, j diagnostics.Job) (*privateipc.ControlClient, error) {
	if ctx.Err() != nil || j.Validate(j.Scope) != nil || j.ManagedPath == nil {
		return nil, diagnostics.ErrInvalid
	}
	p := j.ManagedPath.Hops[0].Identity
	expected := Identity{Scope: Scope{NodeID: p.NodeID, InstanceID: p.InstanceID, EnrollmentEpoch: p.EnrollmentEpoch}, AdapterID: p.AdapterID, CoreVersion: p.CoreVersion, Generation: p.Generation, RevisionID: p.RevisionID, OperationID: p.OperationID, Digest: p.Digest}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.disk.State.RecoveryRequired || r.disk.LastValid == nil || r.disk.LastValid.Identity() != expected || expected.AdapterID != ManagedXrayID || j.Scope != r.disk.Scope {
		return nil, diagnostics.ErrScope
	}
	if leaseDecision(r.effectivePolicy().Lease, r.options.Now(), r.disk.LastWallTime, r.options.MaxLease) != "allowed" {
		return nil, ErrLeaseBlocked
	}
	adapter, e := r.registry.Get(expected.AdapterID, expected.CoreVersion)
	if e != nil {
		return nil, e
	}
	observed, e := adapter.Observe(ctx, r.root)
	if e != nil || !observed.Known || !observed.Quiescent || observed.Identity != expected {
		return nil, ErrUnknownRuntime
	}
	stage, e := currentStage(r.root)
	if e != nil {
		return nil, e
	}
	if e = verifyStage(r.root, stage, *r.disk.LastValid); e != nil {
		return nil, e
	}
	return pipeControlForIdentity(r.root, expected)
}
func (r *Reconciler) runManagedDiagnostic(ctx context.Context, j diagnostics.Job) diagnostics.Result {
	now := time.Now().UTC()
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	client, e := r.diagnosticControl(checkCtx, j)
	cancel()
	if e != nil {
		return diagnostics.Result{Status: "not_run", Phase: "path", Code: "managed_path_not_current", Action: "Apply and observe every selected hop, and check the entry process, exact configuration and policy lease before requesting another diagnostic.", StartedAt: now, FinishedAt: now, CostKnown: true}
	}
	result, e := client.RunDiagnostic(ctx, j)
	if e == nil && (diagnostics.Report{JobID: j.ID, Scope: j.Scope, AttemptID: j.AttemptID, Result: result}).Validate(j) == nil {
		return result
	}
	finished := time.Now().UTC()
	return diagnostics.Result{Status: "unknown", Phase: "path", Code: "managed_probe_outcome_unknown", Action: "The private runtime did not return a valid terminal measurement. Traffic may have been sent; no automatic retry was performed.", StartedAt: now, FinishedAt: finished, DurationMS: finished.Sub(now).Milliseconds(), CostKnown: false}
}

func (w *DiagnosticWorker) bindManaged(r *Reconciler) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.executor.managed = r.runManagedDiagnostic
}
