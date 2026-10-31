//go:build !linux

package agent

import (
	"context"
	"errors"
)

func (s *ProcessSupervisor) Activate(context.Context, Staged) error {
	return errors.New("owned process supervision requires Linux /proc identity")
}
func (s *ProcessSupervisor) Observe(context.Context, string) (Observation, error) {
	return Observation{}, ErrUnknownRuntime
}
func (s *ProcessSupervisor) Stop(context.Context, string) error {
	return errors.New("owned process supervision requires Linux /proc identity")
}
