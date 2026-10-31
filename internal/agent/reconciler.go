package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

type Options struct {
	CoreInstaller     *CoreInstaller
	InstallSupervisor *SupervisorOptions
	MaxLease          time.Duration
	Now               func() time.Time
}
type Reconciler struct {
	mu       sync.Mutex
	root     string
	registry *Registry
	options  Options
	lock     *os.File
	disk     journal
	closed   bool
}

// Open takes an exclusive process lock. A loaded journal never permits mutation
// before reconciling the adapter's actual state and quiescence.
func Open(root string, scope Scope, registry *Registry, options Options) (*Reconciler, error) {
	if !domain.ValidID(scope.NodeID) || !domain.ValidID(scope.InstanceID) || !domain.ValidID(scope.EnrollmentEpoch) {
		return nil, errors.New("invalid local scope")
	}
	if registry == nil || options.MaxLease <= 0 {
		return nil, errors.New("registry and explicit lease maximum required")
	}
	if options.InstallSupervisor != nil {
		supervisor := *options.InstallSupervisor
		options.InstallSupervisor = &supervisor
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("agent root must be a real private directory")
	}
	if info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("agent root must not be group or world accessible")
	}
	lock, err := lockRoot(abs)
	if err != nil {
		return nil, err
	}
	r := &Reconciler{root: abs, registry: registry.snapshot(), options: options, lock: lock, disk: journal{Schema: 1, Scope: scope, State: State{Phase: "empty"}}}
	err = readJSON(filepath.Join(abs, "state.json"), &r.disk)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		r.Close()
		return nil, errors.New("agent journal unreadable")
	}
	if err == nil {
		if r.disk.Schema != 1 || r.disk.Scope != scope {
			r.Close()
			return nil, errors.New("agent journal scope or schema mismatch")
		}
		if r.disk.Payload != nil {
			d := r.disk.Payload
			if r.disk.LatestPolicy == nil && d.Action != "install" {
				lease := d.Lease
				r.disk.LatestPolicy = &lease
				if lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) {
					r.disk.PolicyIssuedHighWater = lease.IssuedAt
				}
			}
			if controlprotocol.ValidateRetainedDesired(*d, scope) != nil || d.Generation != r.disk.State.HighestAccepted || requestDigest(*d) != r.disk.RequestDigest {
				r.Close()
				return nil, errors.New("agent journal identity mismatch")
			}
			if r.disk.State.Desired == nil || *r.disk.State.Desired != d.Identity() {
				r.Close()
				return nil, errors.New("journal desired identity mismatch")
			}
			if r.disk.LastValid != nil && (controlprotocol.ValidateRetainedDesired(*r.disk.LastValid, scope) != nil || r.disk.LastValid.Generation > d.Generation) {
				r.Close()
				return nil, errors.New("journal last-valid identity mismatch")
			}
			for _, lease := range []*PolicyLease{r.disk.LatestPolicy} {
				if lease != nil && lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) {
					r.disk.PolicyIssuedHighWater = lease.IssuedAt
				}
			}
			if r.disk.LastValid != nil && r.disk.LastValid.Lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) {
				r.disk.PolicyIssuedHighWater = r.disk.LastValid.Lease.IssuedAt
			}
			r.disk.State.RecoveryRequired = true
		} else if r.disk.State.HighestAccepted != 0 {
			r.Close()
			return nil, errors.New("journal missing fenced payload")
		}
	}
	if err = r.loadInstalledAdapters(); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}
func (r *Reconciler) Root() string { return r.root }
func (r *Reconciler) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	return unlockRoot(r.lock)
}
func (r *Reconciler) State() State { r.mu.Lock(); defer r.mu.Unlock(); return copyState(r.disk.State) }
func copyState(s State) State {
	if s.Installation != nil {
		installation := *s.Installation
		s.Installation = &installation
	}
	if s.Desired != nil {
		v := *s.Desired
		s.Desired = &v
	}
	if s.Observed != nil {
		v := *s.Observed
		s.Observed = &v
	}
	if s.LastKnownValid != nil {
		v := *s.LastKnownValid
		s.LastKnownValid = &v
	}
	return s
}
func (r *Reconciler) persist() error {
	if err := writeJSON(filepath.Join(r.root, "state.json"), r.disk); err != nil {
		r.disk.State.RecoveryRequired = true
		r.disk.State.Phase = Unknown
		r.disk.State.Code = "journal_write_failed"
		return err
	}
	return nil
}
func (r *Reconciler) out(err error) (State, error) { return copyState(r.disk.State), err }
func (r *Reconciler) fail(phase, code string, err error) (State, error) {
	r.disk.State.Phase = phase
	r.disk.State.Code = code
	if e := r.persist(); e != nil {
		return r.out(e)
	}
	return r.out(err)
}
func (r *Reconciler) gate(d Desired) error {
	now := r.options.Now()
	decision := leaseDecision(d.Lease, now, r.disk.LastWallTime, r.options.MaxLease)
	r.disk.State.AccessDecision = decision
	if now.After(r.disk.LastWallTime) {
		r.disk.LastWallTime = now
	}
	if decision != "allowed" {
		return ErrLeaseBlocked
	}
	return nil
}

// Submit is a serialized mutation lane. The durable high-water mark is written
// before validation or activation. A newer command cannot overtake a pending
// operation, and an uncertain outcome prevents the next activation.
func (r *Reconciler) Submit(ctx context.Context, d Desired) (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	// Copy caller-owned slices before retention and hashing.
	d.Artifacts = append([]domain.Artifact(nil), d.Artifacts...)
	if d.Transition != nil {
		transition := *d.Transition
		d.Transition = &transition
	}
	if err := validateDesired(d, r.disk.Scope); err != nil {
		return r.out(err)
	}
	var a Adapter
	var err error
	if d.CoreReleaseID == "" {
		targetID, targetVersion := d.AdapterID, d.CoreVersion
		if d.Action == "stop" && r.disk.LastValid != nil {
			targetID, targetVersion = r.disk.LastValid.AdapterID, r.disk.LastValid.CoreVersion
		}
		a, err = r.registry.Get(targetID, targetVersion)
		if err != nil {
			return r.out(err)
		}
	} else if r.options.CoreInstaller == nil {
		return r.out(errors.New("core installation is not enabled on this agent; configure a private official release store"))
	}
	if d.Generation < r.disk.State.HighestAccepted {
		return r.out(ErrStaleGeneration)
	}

	same := d.Generation == r.disk.State.HighestAccepted
	if same && requestDigest(d) != r.disk.RequestDigest {
		return r.out(ErrGenerationConflict)
	}
	if r.disk.State.RecoveryRequired {
		if _, err = r.recoverLocked(ctx); err != nil && !((errors.Is(err, ErrLeaseBlocked) || errors.Is(err, controlprotocol.ErrCoreReleaseRetired)) && !r.disk.State.RecoveryRequired && !same) {
			return r.out(err)
		}
	}
	if same {
		switch r.disk.State.Phase {
		case ObservedConformant, ValidationFailed, ApplyFailed, Blocked, NativeValidated, "stopped", "installed":
			// A retry returns the durable result, never a new native mutation.
			if d.Action == "install" && r.disk.State.Phase == "installed" {
				return r.out(nil)
			}
			if err = r.gate(d); err != nil {
				return r.restrictLocked(ctx)
			}
			if err = r.persist(); err != nil {
				return r.out(err)
			}
			if r.disk.State.Phase != ObservedConformant {
				return r.out(phaseError(r.disk.State.Code))
			}
			return r.out(nil)
		}
	} else {
		if err = r.validateTransitionLocked(d); err != nil {
			return r.out(err)
		}
		previous, err := currentStage(r.root)
		if err != nil {
			return r.out(err)
		}
		identity := d.Identity()
		r.disk.State.HighestAccepted = d.Generation
		r.disk.State.Desired = &identity
		r.disk.State.Phase = Accepted
		r.disk.State.Code = ""
		r.disk.State.NativeChecked = false
		r.disk.Payload = &d
		if d.Action != "install" {
			lease := d.Lease
			r.disk.LatestPolicy = &lease
			if lease.IssuedAt.After(r.disk.PolicyIssuedHighWater) {
				r.disk.PolicyIssuedHighWater = lease.IssuedAt
			}
		}
		if d.Action == "install" {
			r.disk.State.Installation = nil
		}
		r.disk.RequestDigest = requestDigest(d)
		r.disk.Stage = ""
		r.disk.PreviousStage = previous
		if err = r.persist(); err != nil {
			return r.out(err)
		}
	}
	if d.Action != "install" {
		if err = r.gate(d); err != nil {
			return r.restrictLocked(ctx)
		}
	}
	if err = ctx.Err(); err != nil {
		return r.fail(Blocked, "cancelled_before_activation", err)
	}
	var installation *controlprotocol.CoreInstallation
	if d.CoreReleaseID != "" {
		var installed InstalledCore
		installed, err = r.prepareCoreLocked(ctx, d.CoreReleaseID)
		if err != nil {
			if r.disk.State.RecoveryRequired {
				return r.fail(Unknown, "core_install_policy_restriction_unknown", err)
			}
			return r.fail(Blocked, "core_installation_failed", err)
		}
		a, err = r.installedAdapterLocked(installed, d.Action != "install")
		if err != nil {
			return r.fail(Blocked, "installed_adapter_unavailable", err)
		}
		installation = &controlprotocol.CoreInstallation{ReleaseID: installed.Release.ID, AdapterID: installed.Release.AdapterID, Version: installed.Release.Version, Platform: installed.Release.Platform, ExecutableSHA256: installed.Release.ExecutableSHA256}
	}
	stage, err := stageFiles(r.root, d)
	if err != nil {
		return r.fail(Blocked, "staging_failed", err)
	}
	r.disk.Stage = stage
	staged := Staged{Desired: d, Directory: filepath.Join(r.root, stage), Root: r.root, nativeReceipt: &nativeValidationReceipt{}}
	if err = r.awaitPreparationLocked(ctx, func(ctx context.Context) error { return a.Validate(ctx, staged) }); err != nil {
		if r.disk.State.RecoveryRequired {
			return r.fail(Unknown, "validation_policy_restriction_unknown", err)
		}
		return r.fail(ValidationFailed, "native_validation_failed", err)
	}
	// The local fixture validator is deliberately not native-core evidence.
	r.disk.State.NativeChecked = a.Descriptor().NativeValidation
	r.disk.State.Phase = NativeValidated
	if err = r.persist(); err != nil {
		return r.out(err)
	}
	if installation != nil {
		r.disk.State.Installation = installation
	}
	if d.Action == "install" {
		r.disk.State.Phase = "installed"
		r.disk.State.Code = "artifact_installed"
		r.disk.State.RecoveryRequired = false
		return r.out(r.persist())
	}
	if !a.Descriptor().CanActivate {
		return r.fail(Blocked, "activation_unverified", ErrUnsupportedActivation)
	}
	if err = r.gate(d); err != nil {
		return r.restrictLocked(ctx)
	}
	if err = verifyStage(r.root, stage, d); err != nil {
		return r.fail(Blocked, "staged_artifact_changed", err)
	}
	if verified, ok := a.(interface{ verifyPreparedActivation(Staged) error }); ok {
		if err = r.awaitPreparationLocked(ctx, func(context.Context) error { return verified.verifyPreparedActivation(staged) }); err != nil {
			if r.disk.State.RecoveryRequired {
				return r.fail(Unknown, "activation_input_policy_restriction_unknown", err)
			}
			return r.fail(ValidationFailed, "validated_activation_inputs_changed", err)
		}
	}
	r.disk.State.Phase = Applying
	r.disk.State.RecoveryRequired = true
	if err = r.persist(); err != nil {
		return r.out(err)
	}
	if d.Transition != nil {
		if err = r.stopTransitionSourceLocked(ctx, d); err != nil {
			return r.fail(Unknown, "transition_source_stop_unconfirmed", err)
		}
	}
	if err = switchStage(r.root, stage); err != nil {
		return r.fail(Unknown, "atomic_switch_uncertain", err)
	}
	if err = a.Activate(ctx, staged); err != nil {
		var notApplied *NotAppliedError
		if errors.As(err, &notApplied) {
			if restoreErr := switchStage(r.root, r.disk.PreviousStage); restoreErr != nil {
				return r.fail(Unknown, "pointer_restore_uncertain", restoreErr)
			}
			r.disk.State.RecoveryRequired = false
			return r.fail(ApplyFailed, "activation_not_applied", err)
		}
		return r.fail(Unknown, "activation_outcome_unknown", ErrUnknownRuntime)
	}
	r.disk.State.Phase = AppliedUnobserved
	if err = r.persist(); err != nil {
		return r.out(err)
	}
	return r.recoverLocked(ctx)
}

func (r *Reconciler) Recover(ctx context.Context) (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	return r.recoverLocked(ctx)
}
func (r *Reconciler) recoverLocked(ctx context.Context) (State, error) {
	if r.disk.Payload == nil {
		return r.out(nil)
	}
	d := *r.disk.Payload
	if d.Action == "install" {
		return r.recoverInstallationLocked(ctx)
	}
	targetID, targetVersion := d.AdapterID, d.CoreVersion
	if d.Action == "stop" && r.disk.LastValid != nil {
		targetID, targetVersion = r.disk.LastValid.AdapterID, r.disk.LastValid.CoreVersion
	}
	a, err := r.registry.Get(targetID, targetVersion)
	if err != nil {
		// Preparation may fail before an adapter exists. Re-observe the exact
		// last valid owner only when no candidate stage could have activated.
		a, _, err = r.observeRuntimeLocked(ctx, d)
		if err != nil {
			return r.fail(Unknown, "adapter_missing", err)
		}
	}
	if !a.Descriptor().CanActivate {
		// Validation-only adapters have never been allowed to mutate a runtime.
		r.disk.State.RecoveryRequired = false
		if d.Action == "upgrade" && r.disk.State.Phase != ObservedConformant {
			if _, err := controlprotocol.FindInstallableCoreRelease(d.CoreReleaseID); err != nil {
				return r.fail(Blocked, "core_release_retired", err)
			}
		}
		return r.out(r.persist())
	}
	_, obs, err := r.observeRuntimeLocked(ctx, d)
	if err != nil || !obs.Quiescent || !obs.Known {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "runtime_observation_unknown", ErrUnknownRuntime)
	}
	if obs.Identity == d.Identity() {
		current, err := currentStage(r.root)
		if err != nil || current != r.disk.Stage || verifyStage(r.root, current, d) != nil {
			r.disk.State.RecoveryRequired = true
			return r.fail(Unknown, "active_artifact_drift", ErrUnknownRuntime)
		}
		r.disk.State.Observed = &obs
		r.disk.State.LastKnownValid = r.disk.State.Desired
		r.disk.LastValid = &d
		r.disk.State.Phase = ObservedConformant
		r.disk.State.Code = ""
		r.disk.State.RecoveryRequired = false
		if err = r.gate(d); err != nil {
			return r.restrictLocked(ctx)
		}
		return r.out(r.persist())
	}
	oldMatches := r.disk.LastValid != nil && obs.Identity == r.disk.LastValid.Identity()
	absent := obs.Generation == 0
	if oldMatches || absent {
		if oldMatches {
			r.disk.State.Observed = &obs
		} else {
			r.disk.State.Observed = nil
		}
		if r.disk.State.Phase == Applying || r.disk.State.Phase == AppliedUnobserved || r.disk.State.Phase == Unknown {
			if err = switchStage(r.root, r.disk.PreviousStage); err != nil {
				return r.fail(Unknown, "pointer_restore_uncertain", err)
			}
			r.disk.State.Phase = ApplyFailed
			r.disk.State.Code = "recovered_not_applied"
		}
		if absent && r.disk.State.Phase == ObservedConformant {
			r.disk.State.Phase = ApplyFailed
			r.disk.State.Code = "runtime_not_running"
		}
		r.disk.State.RecoveryRequired = false
		if err = r.gate(r.effectivePolicy()); err != nil {
			return r.restrictLocked(ctx)
		}
		if d.Action == "upgrade" {
			if _, err := controlprotocol.FindInstallableCoreRelease(d.CoreReleaseID); err != nil {
				return r.fail(Blocked, "core_release_retired", err)
			}
		}
		return r.out(r.persist())
	}
	r.disk.State.RecoveryRequired = true
	return r.fail(Unknown, "runtime_identity_mismatch", ErrUnknownRuntime)
}

// CheckAccess evaluates the last known valid authorization, not unactivated new
// intent. It does NOT claim to terminate native sessions. Drivers must use an
// independently verified enforcement adapter before enabling production use.
func (r *Reconciler) CheckAccess() (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	if r.disk.LastValid == nil && r.disk.Payload == nil {
		return r.fail(Blocked, "no_last_known_valid_policy", ErrLeaseBlocked)
	}
	if err := r.gate(r.effectivePolicy()); err != nil {
		if r.completedInstallation() {
			if err = r.persist(); err != nil {
				return r.out(err)
			}
			return r.out(ErrLeaseBlocked)
		}
		return r.fail(Blocked, "policy_lease_blocked", err)
	}
	return r.out(r.persist())
}

// PolicyRestrictor is an explicit, capability-specific local stop primitive.
// ProcessSupervisor stops its whole owned instance, not an individual account.
// Per-account existing-session termination remains a separate runtime gate.
type PolicyRestrictor interface {
	Restrict(context.Context, string) error
}

// EnforcePolicy blocks further local admission and, for an enabled restrictor,
// stops the owned runtime on an expired/uncertain last-valid lease. Drivers must
// poll this while serving: a one-shot CLI invocation is not an offline daemon.
func (r *Reconciler) EnforcePolicy(ctx context.Context) (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	if r.disk.LastValid == nil && r.disk.Payload != nil && r.disk.Payload.Action == "install" {
		return r.out(nil)
	}
	if r.disk.LastValid == nil && r.disk.Payload == nil {
		return r.fail(Blocked, "no_last_known_valid_policy", ErrLeaseBlocked)
	}
	if err := r.gate(r.effectivePolicy()); err == nil {
		return r.out(r.persist())
	}
	return r.restrictLocked(ctx)
}

// A newly accepted denial takes priority over a previously valid offline lease.
// A failed candidate cannot extend the old runtime's lease merely by existing.
func (r *Reconciler) effectivePolicy() Desired {
	if r.disk.LatestPolicy != nil && leaseDecision(*r.disk.LatestPolicy, r.options.Now(), r.disk.LastWallTime, r.options.MaxLease) != "allowed" {
		d := *r.disk.Payload
		d.Lease = *r.disk.LatestPolicy
		return d
	}
	if r.disk.Payload != nil && r.disk.Payload.Action == "install" && r.disk.LastValid != nil {
		return *r.disk.LastValid
	}
	if r.disk.Payload != nil && leaseDecision(r.disk.Payload.Lease, r.options.Now(), r.disk.LastWallTime, r.options.MaxLease) != "allowed" {
		return *r.disk.Payload
	}
	if r.disk.LastValid != nil {
		return *r.disk.LastValid
	}
	return *r.disk.Payload
}
func (r *Reconciler) restrictLocked(ctx context.Context) (State, error) {
	if r.disk.LastValid == nil && r.disk.Payload == nil {
		return r.fail(Blocked, "policy_lease_blocked", ErrLeaseBlocked)
	}
	installed := r.completedInstallation()
	a, observed, err := r.observeRuntimeLocked(ctx, *r.disk.Payload)
	if err != nil {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "policy_enforcer_observation_unknown", err)
	}
	if !observed.Known || !observed.Quiescent {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "policy_restriction_unknown", ErrUnknownRuntime)
	}
	if !a.Descriptor().CanActivate {
		return r.fail(Blocked, "policy_lease_blocked", ErrLeaseBlocked)
	}
	restrictor, ok := a.(PolicyRestrictor)
	if !ok {
		return r.fail(Blocked, "policy_enforcement_unverified", ErrUnsupportedActivation)
	}
	if err = restrictor.Restrict(ctx, r.root); err != nil {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "policy_restriction_unknown", ErrUnknownRuntime)
	}
	obs, err := a.Observe(ctx, r.root)
	if err != nil || !obs.Quiescent || !obs.Known || obs.Generation != 0 {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "policy_restriction_unobserved", ErrUnknownRuntime)
	}
	r.disk.State.Observed = nil
	r.disk.State.RecoveryRequired = false
	if installed {
		// Artifact preparation is independent of runtime authorization. Keep
		// its confirmed result while reporting denied access and no process.
		if err = r.persist(); err != nil {
			return r.out(err)
		}
		return r.out(ErrLeaseBlocked)
	}
	return r.fail(Blocked, "policy_restricted", ErrLeaseBlocked)
}

// StopOwned serializes local-session shutdown with every activation/recovery.
// It does not revoke a desired generation or edit another system service.
func (r *Reconciler) StopOwned(ctx context.Context) (State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.out(errors.New("agent is closed"))
	}
	if r.disk.Payload == nil {
		return r.out(nil)
	}
	d := *r.disk.Payload
	installed := r.completedInstallation()
	if d.Action == "install" && r.disk.LastValid == nil {
		return r.out(nil)
	}
	a, observed, err := r.observeRuntimeLocked(ctx, d)
	if err != nil {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "owned_stop_observation_unknown", err)
	}
	if !observed.Known || !observed.Quiescent {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "owned_stop_unknown", ErrUnknownRuntime)
	}
	restrictor, ok := a.(PolicyRestrictor)
	if !ok {
		return r.out(ErrUnsupportedActivation)
	}
	if err = restrictor.Restrict(ctx, r.root); err != nil {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "owned_stop_unknown", err)
	}
	obs, err := a.Observe(ctx, r.root)
	if err != nil || !obs.Known || !obs.Quiescent || obs.Generation != 0 {
		r.disk.State.RecoveryRequired = true
		return r.fail(Unknown, "owned_stop_unobserved", ErrUnknownRuntime)
	}
	r.disk.State.Observed = nil
	r.disk.State.Phase = "stopped"
	r.disk.State.Code = "local_session_stopped"
	if installed {
		r.disk.State.Phase = "installed"
		r.disk.State.Code = "artifact_installed"
	}
	r.disk.State.RecoveryRequired = false
	return r.out(r.persist())
}
