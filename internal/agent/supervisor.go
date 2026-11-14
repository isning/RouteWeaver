package agent

import (
	"context"
	"errors"
	"time"
)

type SupervisorOptions struct {
	CoreDiagnostics *CoreDiagnostics
	// This explicit local opt-in is never inferred from a rendered artifact.
	AllowLocalProcess bool
	StartupGrace      time.Duration
	StopTimeout       time.Duration
}

// ProcessSupervisor manages only direct child processes whose durable OS
// identities match its private journal. It does not install or touch services,
// system routing, firewalls, other processes, or any control-plane credential.
// Its evidence is process liveness, never proof of route/egress/policy behavior.
type ProcessSupervisor struct {
	checker *NativeChecker
	options SupervisorOptions
}

func NewProcessSupervisor(checker *NativeChecker, options SupervisorOptions) (*ProcessSupervisor, error) {
	if checker == nil || !options.AllowLocalProcess {
		return nil, errors.New("explicit local process opt-in required")
	}
	if options.StartupGrace <= 0 || options.StartupGrace > 10*time.Second || options.StopTimeout <= 0 || options.StopTimeout > 30*time.Second {
		return nil, errors.New("bounded supervisor timeouts required")
	}
	checker.coreDiagnostics = options.CoreDiagnostics
	return &ProcessSupervisor{checker: checker, options: options}, nil
}
func (s *ProcessSupervisor) Descriptor() Descriptor {
	d := s.checker.Descriptor()
	d.CanActivate = true
	d.Evidence = "owned_process_liveness"
	return d
}
func (s *ProcessSupervisor) Validate(ctx context.Context, st Staged) error {
	return s.checker.Validate(ctx, st)
}

func (s *ProcessSupervisor) Restrict(ctx context.Context, root string) error {
	return s.Stop(ctx, root)
}
