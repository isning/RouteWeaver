//go:build !linux

package managedxray

import (
	"context"
	"errors"
	"routeweaver/internal/entrypolicy"
)

type SocketAdmission struct{}

func NewSocketAdmission(string) (*SocketAdmission, error) {
	return nil, errors.New("verified private peer credentials require Linux")
}
func (*SocketAdmission) Acquire(context.Context, entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{}, errors.New("unsupported platform")
}
func (*SocketAdmission) Release(context.Context, string) error {
	return errors.New("unsupported platform")
}
func (*SocketAdmission) Close() {}
func (*Runtime) ServeControl(string) (func() error, error) {
	return nil, errors.New("verified private peer credentials require Linux")
}
