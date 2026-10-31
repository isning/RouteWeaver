// Package agent reconciles a single enrolled instance through trusted runtime
// adapters. It is independent of rendering, HTTP, and the control-plane store.
// This implementation is a local harness, not a production enrollment service.
package agent

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

var (
	ErrStaleGeneration       = errors.New("stale generation")
	ErrGenerationConflict    = errors.New("generation payload conflict")
	ErrUnknownRuntime        = errors.New("runtime outcome unknown; reconciliation required")
	ErrUnsupportedActivation = errors.New("runtime activation is not verified or enabled")
	ErrLeaseBlocked          = errors.New("policy lease does not permit access")
)

const (
	Accepted           = controlprotocol.Accepted
	NativeValidated    = controlprotocol.NativeValidated
	Applying           = controlprotocol.Applying
	AppliedUnobserved  = controlprotocol.AppliedUnobserved
	ObservedConformant = controlprotocol.ObservedConformant
	ValidationFailed   = controlprotocol.ValidationFailed
	ApplyFailed        = controlprotocol.ApplyFailed
	Unknown            = controlprotocol.Unknown
	Blocked            = controlprotocol.Blocked
	LocalFixtureID     = "routeweaver/local-fixture"
)

type Scope = controlprotocol.Scope
type PolicyLease = controlprotocol.PolicyLease
type Desired = controlprotocol.Desired
type Identity = controlprotocol.Identity
type Observation = controlprotocol.Observation
type State = controlprotocol.State
type MeterSample = controlprotocol.MeterSample
type MeterBatch = controlprotocol.MeterBatch
type MeterReceipt = controlprotocol.MeterReceipt

type Descriptor struct {
	ID               string `json:"id"`
	Version          string `json:"version"`
	CanActivate      bool   `json:"canActivate"`
	NativeValidation bool   `json:"nativeValidation"`
	Evidence         string `json:"evidence"`
	Source           string `json:"source,omitempty"`
}

type Staged struct {
	nativeReceipt *nativeValidationReceipt
	Desired       Desired
	Directory     string
	Root          string
}

// Adapter methods are synchronous and must not return success while a delayed
// native mutation is still possible. Unknown outcomes block the mutation lane.
// No adapter can receive an arbitrary remote command string.
type Adapter interface {
	Descriptor() Descriptor
	Validate(context.Context, Staged) error
	Activate(context.Context, Staged) error
	Observe(context.Context, string) (Observation, error)
}

// NotAppliedError is allowed only when the adapter has proved no runtime side
// effect occurred and no delayed operation can complete. It permits reverting
// an uncommitted file pointer, not silently rolling back an active deployment.
type NotAppliedError struct{ Code string }

func (e *NotAppliedError) Error() string { return e.Code }

type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{adapters: map[string]Adapter{}}
	for _, a := range adapters {
		if err := r.Register(a); err != nil {
			panic(err)
		}
	}
	return r
}

var adapterPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$`)

func (r *Registry) Register(a Adapter) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.adapters == nil {
		r.adapters = map[string]Adapter{}
	}
	if a == nil {
		return errors.New("nil runtime adapter")
	}
	d := a.Descriptor()
	if !adapterPattern.MatchString(d.ID) || d.Version == "" {
		return errors.New("invalid runtime descriptor")
	}
	key := d.ID + "@" + d.Version
	if _, ok := r.adapters[key]; ok {
		return errors.New("duplicate runtime descriptor")
	}
	r.adapters[key] = a
	return nil
}
func (r *Registry) Get(id, version string) (Adapter, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[id+"@"+version]
	if !ok {
		return nil, errors.New("runtime descriptor not registered")
	}
	return a, nil
}
func (r *Registry) Descriptors() []Descriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []Descriptor{}
	for _, a := range r.adapters {
		out = append(out, a.Descriptor())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID+out[i].Version < out[j].ID+out[j].Version })
	return out
}

func ArtifactDigest(artifacts []domain.Artifact) (string, error) {
	return controlprotocol.ArtifactDigest(artifacts)
}
func validateDesired(d Desired, scope Scope) error { return controlprotocol.ValidateDesired(d, scope) }
func requestDigest(d Desired) string               { return controlprotocol.RequestDigest(d) }
func leaseDecision(l PolicyLease, now, last time.Time, max time.Duration) string {
	if now.Before(last) {
		return "clock_rollback"
	}
	if l.Revision == "" || !l.AccessAllowed {
		return "access_denied"
	}
	if !l.QuotaCertain {
		return "quota_uncertain"
	}
	if l.IssuedAt.IsZero() || l.ExpiresAt.IsZero() || !l.ExpiresAt.After(l.IssuedAt) || l.ExpiresAt.Sub(l.IssuedAt) > max {
		return "invalid_lease"
	}
	if now.Before(l.IssuedAt) {
		return "lease_not_yet_valid"
	}
	if !now.Before(l.ExpiresAt) {
		return "lease_expired"
	}
	return "allowed"
}

// ControlPlaneTransport is an outbound port. HTTPTransport implements bounded
// authenticated polling/reporting, but does not enroll nodes or issue credentials.
type ControlPlaneTransport interface {
	ReceiveDesired(context.Context, Scope, uint64) (*Desired, error)
	ReportObservation(context.Context, Scope, State) error
	SendMeterBatch(context.Context, MeterBatch) (MeterReceipt, error)
}

func phaseError(code string) error { return fmt.Errorf("agent: %s", code) }

// Each instance owns its registration set. Installing an adapter must not mutate
// another instance's registry or its activation opt-in via a shared caller map.
func (r *Registry) snapshot() *Registry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	copy := &Registry{adapters: map[string]Adapter{}}
	for key, adapter := range r.adapters {
		copy.adapters[key] = adapter
	}
	return copy
}
func (r *Registry) replacePrepared(adapter Adapter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := adapter.Descriptor()
	r.adapters[d.ID+"@"+d.Version] = adapter
}
