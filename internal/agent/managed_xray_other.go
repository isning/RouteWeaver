//go:build !linux

package agent

import (
	"context"
	"errors"
	"routeweaver/internal/entrypolicy"
)

type UnixAdmissionBroker struct{}

func StartUnixAdmissionBroker(string, entrypolicy.Admission) (*UnixAdmissionBroker, error) {
	return nil, errors.New("verified private peer credentials require Linux")
}
func (*UnixAdmissionBroker) Close() error { return nil }
func ReadManagedUnixSnapshot(context.Context, string) (entrypolicy.Snapshot, error) {
	return entrypolicy.Snapshot{}, errors.New("unsupported platform")
}
func RevokeManagedUnixAccount(context.Context, string, string) error {
	return errors.New("unsupported platform")
}
