package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

type HostServiceOptions struct {
	ObserveNode       bool
	StateDir          string
	CoreStore         string
	Transport         HTTPTransportOptions
	MaxLease          time.Duration
	AllowProcess      bool
	ManagedXrayBinary string
	Diagnostics       bool
	CoreDiagnostics   bool
	RawCoreLogs       bool
	OnError           func(error)
}

// RunHostService starts one server agent, including an empty server with no
// installed cores. Download and process activation remain explicit local opt-ins.
func RunHostService(ctx context.Context, o HostServiceOptions) error {
	if o.StateDir == "" || o.CoreStore == "" || o.MaxLease <= 0 || o.MaxLease > 24*time.Hour || o.Transport.Scope.InstanceID != "host-agent" || !domain.ValidID(o.Transport.Scope.NodeID) || !domain.ValidID(o.Transport.Scope.EnrollmentEpoch) || ((o.RawCoreLogs || o.CoreDiagnostics) && !o.AllowProcess) {
		return errors.New("host service requires private state, core store and a host identity")
	}
	root, err := filepath.Abs(o.StateDir)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("host agent state must be a private real directory")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != root {
		return errors.New("host agent state must not contain symlinks")
	}
	lock, err := lockRoot(root)
	if err != nil {
		return err
	}
	defer unlockRoot(lock)
	identity := struct {
		NodeID          string `json:"nodeId"`
		EnrollmentEpoch string `json:"enrollmentEpoch"`
	}{o.Transport.Scope.NodeID, o.Transport.Scope.EnrollmentEpoch}
	var saved struct {
		NodeID          string `json:"nodeId"`
		EnrollmentEpoch string `json:"enrollmentEpoch"`
	}
	identityPath := filepath.Join(root, "host-identity.json")
	if err = readJSON(identityPath, &saved); err == nil {
		if saved != identity {
			return errors.New("host agent state belongs to another host enrollment; retain it for recovery and use a new private directory")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("host identity journal unreadable")
	}
	if err = writeJSON(identityPath, identity); err != nil {
		return err
	}
	installer, err := NewCoreInstaller(o.CoreStore, CoreInstallerOptions{})
	if err != nil {
		return err
	}
	transport, err := NewHTTPTransport(o.Transport)
	if err != nil {
		return err
	}
	defer transport.Close()
	var observeHost func(context.Context) error
	if o.ObserveNode {
		collector, err := NewLocalNodeCollector()
		if err != nil {
			return err
		}
		observer, err := NewHostNodeObserver(identity.NodeID, identity.EnrollmentEpoch, collector)
		if err != nil {
			return err
		}
		observeHost = func(ctx context.Context) error { return observer.Observe(ctx, transport) }
	}
	return RunHostDriver(ctx, transport, HostDriverOptions{ObserveHost: observeHost, NodeID: identity.NodeID, EnrollmentEpoch: identity.EnrollmentEpoch, PollInterval: time.Second, ShutdownTimeout: 30 * time.Second, OnTransportError: o.OnError, OnInstanceError: func(id string, err error) {
		if o.OnError != nil {
			o.OnError(hostWorkerError(id, err))
		}
	}, StartInstance: func(instanceCtx context.Context, a controlprotocol.HostAssignment) error {
		return runHostInstance(instanceCtx, root, installer, o, a)
	}})
}
func runHostInstance(ctx context.Context, root string, installer *CoreInstaller, o HostServiceOptions, a controlprotocol.HostAssignment) error {
	stateDir := filepath.Join(root, "instances", a.Instance.ID, a.Scope.EnrollmentEpoch)
	registry := NewRegistry()
	options := Options{MaxLease: o.MaxLease, CoreInstaller: installer}
	transportOptions := o.Transport
	transportOptions.Token = a.Token
	transportOptions.Scope = a.Scope
	transport, err := NewHTTPTransport(transportOptions)
	if err != nil {
		return err
	}
	defer transport.Close()
	var raw *RawCoreLogs
	if o.RawCoreLogs {
		raw, err = OpenRawCoreLogs(a.Scope)
		if err != nil {
			return err
		}
		defer raw.Close()
	}
	var diagnostics *CoreDiagnostics
	if o.CoreDiagnostics {
		diagnostics, err = OpenCoreDiagnostics(filepath.Join(stateDir, "core-diagnostics"), a.Scope)
		if err != nil {
			return err
		}
		defer diagnostics.Close()
	}
	supervisor := SupervisorOptions{AllowLocalProcess: true, StartupGrace: 200 * time.Millisecond, StopTimeout: 2 * time.Second, CoreDiagnostics: diagnostics, RawCoreLogs: raw}
	if o.AllowProcess {
		options.InstallSupervisor = &supervisor
	}
	if a.Instance.AdapterID != ManagedXrayID && a.Instance.AdapterID != "routeweaver/xray" && a.Instance.AdapterID != "routeweaver/sing-box" {
		return errors.New("host core adapter is not supported by the installed catalog")
	}
	if a.Instance.AdapterID == ManagedXrayID && (o.ManagedXrayBinary == "" || !o.AllowProcess) {
		return errors.New("managed Xray requires its packaged trusted binary and explicit process supervision")
	}
	if o.ManagedXrayBinary != "" && o.AllowProcess {
		checker, err := NewManagedXrayChecker(o.ManagedXrayBinary, 5*time.Second)
		if err != nil {
			return err
		}
		runtime, err := NewProcessSupervisor(checker, supervisor)
		if err != nil {
			return err
		}
		if err = registry.Register(runtime); err != nil {
			return err
		}
	}
	reconciler, err := Open(stateDir, a.Scope, registry, options)
	if err != nil {
		return err
	}
	defer reconciler.Close()
	// A deterministic stream label is safe only inside this durable, enrollment-
	// scoped journal. Restart must reuse the same outbox rather than reset meters.
	meter, err := OpenMeterSpool(filepath.Join(stateDir, "meters"), a.Scope, "host-meter-v1")
	if err != nil {
		return err
	}
	defer meter.Close()
	var worker *DiagnosticWorker
	if o.Diagnostics {
		worker, err = OpenDiagnosticWorker(filepath.Join(stateDir, "diagnostics"), a.Scope, NewDiagnosticExecutor(DiagnosticExecutorOptions{}))
		if err != nil {
			return err
		}
		defer worker.Close()
	}
	_, err = RunDriver(ctx, reconciler, transport, meter, DriverOptions{CoreDiagnostics: diagnostics, RawCoreLogs: raw, Diagnostics: worker, PollInterval: time.Second, LeaseInterval: 250 * time.Millisecond, Continuous: true, OnTransportError: o.OnError})
	return err
}
