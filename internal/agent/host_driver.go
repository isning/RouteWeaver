package agent

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

type HostControlPlaneTransport interface {
	ReceiveHostAssignments(context.Context) (controlprotocol.HostAssignments, error)
}

func (t *HTTPTransport) ReceiveHostAssignments(ctx context.Context) (controlprotocol.HostAssignments, error) {
	var manifest controlprotocol.HostAssignments
	raw, status, err := t.request(ctx, "GET", "/api/agent/hosts/"+url.PathEscape(t.scope.NodeID)+"/assignments", nil)
	if err != nil {
		return manifest, err
	}
	if status != 200 {
		return manifest, &TransportError{Status: status, Code: "host_assignments_unavailable"}
	}
	if err = decodeWire(raw, &manifest); err != nil {
		return manifest, errors.New("invalid host assignment response")
	}
	return manifest, nil
}

type HostDriverOptions struct {
	ObserveHost      func(context.Context) error
	NodeID           string
	EnrollmentEpoch  string
	PollInterval     time.Duration
	ShutdownTimeout  time.Duration
	StartInstance    func(context.Context, controlprotocol.HostAssignment) error
	OnInstanceError  func(string, error)
	OnTransportError func(error)
}
type hostWorker struct {
	assignment controlprotocol.HostAssignment
	cancel     context.CancelFunc
	done       chan struct{}
	finished   bool
	removed    bool
	pending    *controlprotocol.HostAssignment
}
type hostWorkerResult struct {
	id     string
	worker *hostWorker
	err    error
}

func validateHostAssignments(m controlprotocol.HostAssignments, o HostDriverOptions) error {
	if m.NodeID != o.NodeID || m.EnrollmentEpoch != o.EnrollmentEpoch || !time.Now().Before(m.ExpiresAt) || m.Instances == nil || len(m.Instances) > controlprotocol.MaxHostInstances {
		return errors.New("host assignment scope invalid or expired")
	}
	seen := map[string]bool{}
	for _, a := range m.Instances {
		if !domain.ValidID(a.Instance.ID) || a.Instance.HostID != m.NodeID || a.Scope.NodeID != m.NodeID || a.Scope.InstanceID != a.Instance.ID || !domain.ValidID(a.Scope.EnrollmentEpoch) || a.Token == "" || len(a.Token) > 8192 || strings.ContainsAny(a.Token, "\r\n\x00") || seen[a.Instance.ID] {
			return errors.New("invalid or duplicate host core assignment")
		}
		seen[a.Instance.ID] = true
	}
	return nil
}
func sameHostWorker(a, b controlprotocol.HostAssignment) bool {
	return a.Scope == b.Scope && a.Token == b.Token
}

// RunHostDriver is one host's long-lived agent. Every core retains its own
// reconciliation lane, durable journal, credentials, generations and leases.
// Network failure never replaces a verified assignment with a partial list.
func RunHostDriver(parent context.Context, tr HostControlPlaneTransport, o HostDriverOptions) error {
	if tr == nil || !domain.ValidID(o.NodeID) || !domain.ValidID(o.EnrollmentEpoch) || o.StartInstance == nil || o.PollInterval <= 0 || o.PollInterval > time.Minute || o.ShutdownTimeout <= 0 || o.ShutdownTimeout > time.Minute {
		return errors.New("bounded host agent configuration required")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	workers := map[string]*hostWorker{}
	completed := make(chan hostWorkerResult, controlprotocol.MaxHostInstances)
	start := func(a controlprotocol.HostAssignment) {
		childCtx, stop := context.WithCancel(ctx)
		worker := &hostWorker{assignment: a, cancel: stop, done: make(chan struct{})}
		workers[a.Instance.ID] = worker
		go func() {
			err := o.StartInstance(childCtx, a)
			close(worker.done)
			select {
			case completed <- hostWorkerResult{id: a.Instance.ID, worker: worker, err: err}:
			case <-ctx.Done():
			}
		}()
	}
	stopAll := func() error {
		cancel()
		for _, worker := range workers {
			worker.cancel()
		}
		timer := time.NewTimer(o.ShutdownTimeout)
		defer timer.Stop()
		for _, worker := range workers {
			select {
			case <-worker.done:
			case <-timer.C:
				return errors.New("host core shutdown requires reconciliation")
			}
		}
		return nil
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	var expires time.Time
	for {
		select {
		case <-ctx.Done():
			return stopAll()
		case result := <-completed:
			if workers[result.id] != result.worker {
				continue
			}
			worker := result.worker
			worker.finished = true
			if result.err != nil && worker.pending == nil && ctx.Err() == nil && o.OnInstanceError != nil {
				o.OnInstanceError(result.id, result.err)
			}
			if worker.pending != nil && time.Now().Before(expires) && ctx.Err() == nil {
				next := *worker.pending
				delete(workers, result.id)
				start(next)
			}
		case <-timer.C:
			if !expires.IsZero() && !time.Now().Before(expires) {
				return stopAll()
			}
			pollCtx := ctx
			stopPoll := func() {}
			if !expires.IsZero() {
				pollCtx, stopPoll = context.WithDeadline(ctx, expires)
			}
			manifest, err := tr.ReceiveHostAssignments(pollCtx)
			stopPoll()
			if err != nil {
				var failure *TransportError
				if errors.As(err, &failure) && (failure.Status == 401 || failure.Status == 403) {
					stopErr := stopAll()
					if stopErr != nil {
						return stopErr
					}
					return errors.New("host agent authorization revoked or expired")
				}
				if ctx.Err() != nil {
					return stopAll()
				}
				if o.OnTransportError != nil {
					o.OnTransportError(err)
				}
				// An accepted authority deadline is independent of successful polling.
				if !expires.IsZero() && !time.Now().Before(expires) {
					return stopAll()
				}
				timer.Reset(hostPollDelay(o.PollInterval, expires))
				continue
			}
			if err = validateHostAssignments(manifest, o); err != nil {
				if o.OnTransportError != nil {
					o.OnTransportError(err)
				}
				if !expires.IsZero() && !time.Now().Before(expires) {
					return stopAll()
				}
				timer.Reset(hostPollDelay(o.PollInterval, expires))
				continue
			}
			expires = manifest.ExpiresAt
			if o.ObserveHost != nil {
				observationCtx, stopObservation := context.WithDeadline(ctx, expires)
				err := o.ObserveHost(observationCtx)
				stopObservation()
				if err != nil && o.OnTransportError != nil {
					o.OnTransportError(err)
				}
			}
			desired := map[string]controlprotocol.HostAssignment{}
			for _, a := range manifest.Instances {
				desired[a.Instance.ID] = a
			}
			for id, worker := range workers {
				next, exists := desired[id]
				if !exists {
					worker.removed = true
					worker.pending = nil
					worker.cancel()
					if worker.finished {
						delete(workers, id)
					}
					continue
				}
				if worker.removed || worker.pending != nil || !sameHostWorker(worker.assignment, next) {
					if worker.finished {
						delete(workers, id)
						start(next)
					} else {
						copy := next
						worker.pending = &copy
						worker.cancel()
					}
				}
			}
			for id, a := range desired {
				if _, exists := workers[id]; !exists {
					start(a)
				}
			}
			timer.Reset(hostPollDelay(o.PollInterval, expires))
		}
	}
}

func hostWorkerError(id string, err error) error {
	return fmt.Errorf("core %s requires reconciliation: %w", id, err)
}

func hostPollDelay(interval time.Duration, expires time.Time) time.Duration {
	if !expires.IsZero() {
		remaining := time.Until(expires)
		if remaining < 0 {
			return 0
		}
		if remaining < interval {
			return remaining
		}
	}
	return interval
}
