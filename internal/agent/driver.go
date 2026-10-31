package agent

import (
	"context"
	"errors"
	"routeweaver/internal/entrypolicy"
	"time"
)

type DriverOptions struct {
	Diagnostics *DiagnosticWorker
	// Opt-in physical-node collector; the control plane enforces one observer.
	NodeObserver  *NodeObserver
	PollInterval  time.Duration
	LeaseInterval time.Duration
	// A session is bounded explicitly. A service installer/supervisor is outside
	// this local harness; no accidental indefinitely running background agent.
	MaxRuntime       time.Duration
	OnTransportError func(error)
}
type desiredDelivery struct {
	desired Desired
	done    chan State
}

// RunDriver polls outward, serializes reconciliation, reports facts, and drains
// the durable meter outbox only after exact receipts. Network I/O has its own
// goroutine, so a disconnected/slow control plane cannot stall the lease timer.
// Shutdown stops only the enabled adapter's owned runtime, even on cancellation.
// A native operation can still occupy the mutation lane for its bounded timeout;
// Submit rechecks the lease before activation and immediately after observation.
func RunDriver(parent context.Context, r *Reconciler, tr ControlPlaneTransport, meter *MeterSpool, o DriverOptions) (State, error) {
	if r == nil || tr == nil || o.PollInterval <= 0 || o.PollInterval > time.Minute || o.LeaseInterval <= 0 || o.LeaseInterval > time.Minute || o.MaxRuntime <= 0 || o.MaxRuntime > 24*time.Hour {
		return State{}, errors.New("bounded driver configuration required")
	}
	ctx, cancel := context.WithTimeout(parent, o.MaxRuntime)
	defer cancel()
	scope := r.scope()
	managed := false
	for _, descriptor := range r.registry.Descriptors() {
		managed = managed || descriptor.ID == ManagedXrayID
	}
	if managed {
		authority, ok := tr.(entrypolicy.Admission)
		if !ok || meter == nil {
			return State{}, errors.New("managed runtime requires authoritative admission and durable meters")
		}
		broker, err := StartAdmissionBroker(r.Root(), authority)
		if err != nil {
			return State{}, err
		}
		defer broker.Close()
	}
	meterErrors := make(chan error, 1)
	// Recovery is observational. Unknown native completion stays blocked; the
	// running loop can retry observation, never replay the uncertain mutation.
	_, _ = r.Recover(ctx)
	deliveries := make(chan desiredDelivery)
	workerDone := make(chan struct{})
	reportError := func(err error) {
		if err != nil && ctx.Err() == nil && o.OnTransportError != nil {
			o.OnTransportError(err)
		}
	}
	diagnosticDone := make(chan struct{})
	if o.Diagnostics != nil {
		o.Diagnostics.bindManaged(r)
		diagnosticTransport, ok := tr.(DiagnosticTransport)
		if !ok {
			return State{}, errors.New("transport does not support diagnostics")
		}
		go func() {
			defer close(diagnosticDone)
			o.Diagnostics.Run(ctx, diagnosticTransport, o.PollInterval, reportError)
		}()
	} else {
		close(diagnosticDone)
	}
	go func() {
		defer close(workerDone)
		tick := time.NewTicker(o.PollInterval)
		defer tick.Stop()
		for {
			desired, err := tr.ReceiveDesired(ctx, scope, r.State().HighestAccepted)
			reportError(err)
			if err == nil && desired != nil {
				delivery := desiredDelivery{desired: *desired, done: make(chan State, 1)}
				select {
				case deliveries <- delivery:
				case <-ctx.Done():
					return
				}
				select {
				case <-delivery.done:
				case <-ctx.Done():
					return
				}
			}
			if ctx.Err() != nil {
				return
			}
			if managed {
				state := r.State()
				live := state.Observed != nil && state.Observed.AdapterID == ManagedXrayID
				if err := CollectManagedCounters(ctx, r.Root(), meter, live); err != nil {
					select {
					case meterErrors <- err:
					default:
					}
					return
				}
			}
			if o.NodeObserver != nil {
				if observerTransport, ok := tr.(NodeObservationTransport); ok {
					reportError(o.NodeObserver.Observe(ctx, observerTransport))
				} else {
					reportError(errors.New("transport does not support node observations"))
				}
			}
			reportError(tr.ReportObservation(ctx, scope, r.State()))
			if meter != nil {
				for _, batch := range meter.Pending() {
					receipt, err := tr.SendMeterBatch(ctx, batch)
					if err != nil {
						reportError(err)
						break
					}
					if err = meter.Ack(receipt); err != nil {
						reportError(err)
						break
					}
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
	leaseTick := time.NewTicker(o.LeaseInterval)
	defer leaseTick.Stop()
	var collectionErr error
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case collectionErr = <-meterErrors:
			break loop
		case delivery := <-deliveries:
			st, _ := r.Submit(ctx, delivery.desired)
			delivery.done <- st
		case <-leaseTick.C:
			state := r.State()
			if state.RecoveryRequired {
				_, _ = r.Recover(ctx)
			}
			if state.Desired != nil {
				_, _ = r.EnforcePolicy(ctx)
			}
		}
	}
	cancel()
	var workerErr error
	select {
	case <-workerDone:
	case <-time.After(5 * time.Second):
		workerErr = errors.New("transport did not quiesce on cancellation")
	}
	select {
	case <-diagnosticDone:
	case <-time.After(5 * time.Second):
		workerErr = errors.New("diagnostics did not quiesce on cancellation")
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer stopCancel()
	final, stopErr := r.StopOwned(stopCtx)
	if managed {
		if err := CollectManagedCounters(stopCtx, r.Root(), meter, false); err != nil && collectionErr == nil {
			collectionErr = err
		}
	}
	if meter != nil {
		for _, batch := range meter.Pending() {
			receipt, err := tr.SendMeterBatch(stopCtx, batch)
			if err != nil {
				if o.OnTransportError != nil {
					o.OnTransportError(err)
				}
				break
			}
			if err = meter.Ack(receipt); err != nil {
				if collectionErr == nil {
					collectionErr = err
				}
				break
			}
		}
	}
	// Final delivery has a fresh, small context; a failed report does not turn a
	// known local stop into a fictional remote acknowledgement.
	reportCtx, reportCancel := context.WithTimeout(context.Background(), time.Second)
	reportErr := tr.ReportObservation(reportCtx, scope, final)
	reportCancel()
	if reportErr != nil && o.OnTransportError != nil {
		o.OnTransportError(reportErr)
	}
	if collectionErr != nil {
		return final, collectionErr
	}
	if workerErr != nil {
		return final, workerErr
	}
	if stopErr != nil {
		return final, stopErr
	}
	return final, nil
}
func (r *Reconciler) scope() Scope { r.mu.Lock(); defer r.mu.Unlock(); return r.disk.Scope }
