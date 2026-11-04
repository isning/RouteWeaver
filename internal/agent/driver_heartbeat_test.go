package agent

import (
	"context"
	"errors"
	"os"
	"routeweaver/internal/controlprotocol"
	"sync/atomic"
	"testing"
	"time"
)

type scheduledHeartbeat struct {
	fact controlprotocol.ServiceHeartbeat
	at   time.Time
}

type heartbeatApplicationFixture struct {
	signalledLeaseFixture
	delayNext atomic.Bool
	entered   chan struct{}
	proceed   chan struct{}
}

func (f *heartbeatApplicationFixture) Observe(ctx context.Context, root string) (Observation, error) {
	if f.delayNext.Swap(false) {
		close(f.entered)
		select {
		case <-f.proceed:
		case <-ctx.Done():
			return Observation{}, ctx.Err()
		}
	}
	return f.LocalFixture.Observe(ctx, root)
}

// Each poll barrier follows the previous iteration's heartbeat and policy
// application. Tests can prove a heartbeat was not sent without sleeping.
type heartbeatCadenceTransport struct {
	driverTransport
	now      func() time.Time
	polls    chan struct{}
	proceed  chan struct{}
	calls    chan scheduledHeartbeat
	response chan struct{}
	result   controlprotocol.ServiceHeartbeatResult
	err      error
	first    bool
	onResult func()
}

func (t *heartbeatCadenceTransport) ReceiveDesired(ctx context.Context, _ Scope, _ uint64) (*Desired, error) {
	select {
	case t.polls <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-t.proceed:
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *heartbeatCadenceTransport) SendServiceHeartbeat(ctx context.Context, fact controlprotocol.ServiceHeartbeat) (controlprotocol.ServiceHeartbeatResult, error) {
	select {
	case t.calls <- scheduledHeartbeat{fact: fact, at: t.now()}:
	case <-ctx.Done():
		return controlprotocol.ServiceHeartbeatResult{}, ctx.Err()
	}
	if !t.first {
		t.first = true
		select {
		case <-t.response:
			if t.onResult != nil {
				t.onResult()
			}
			return t.result, t.err
		case <-ctx.Done():
			return controlprotocol.ServiceHeartbeatResult{}, ctx.Err()
		}
	}
	return controlprotocol.ServiceHeartbeatResult{}, nil
}

func TestContinuousDriverSpacesHeartbeatsFromResponseCompletion(t *testing.T) {
	for _, outcome := range []string{"refresh", "no_refresh", "transport_error", "rejected_refresh", "blocked_until_expiry"} {
		t.Run(outcome, func(t *testing.T) {
			testHeartbeatCompletionCadence(t, outcome)
		})
	}
}

func testHeartbeatCompletionCadence(t *testing.T, outcome string) {
	t.Helper()
	base := time.Now().UTC()
	var clock atomic.Int64
	clock.Store(base.UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	d := testDesired(t, 1)
	d.Lease.IssuedAt = base.Add(-285 * time.Second)
	d.Lease.ExpiresAt = base.Add(15 * time.Second)
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	fixture := &heartbeatApplicationFixture{
		signalledLeaseFixture: signalledLeaseFixture{restricted: make(chan struct{})},
		entered:               make(chan struct{}), proceed: make(chan struct{}),
	}
	r, err := Open(root, d.Scope, NewRegistry(fixture), Options{MaxLease: time.Hour, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if st, err := r.Submit(context.Background(), d); err != nil || st.Phase != ObservedConformant {
		t.Fatalf("initial lease did not activate: %+v %v", st, err)
	}
	// The service receives the request 100 ms after send and throttles until
	// receipt+5s. Its response finishes another 100 ms later. These are separate
	// events; starting the interval at send would make the next request early.
	serverReceived := base.Add(100 * time.Millisecond)
	responseCompleted := base.Add(200 * time.Millisecond)
	handlingCompleted := responseCompleted
	refresh := controlprotocol.PolicyRefresh{Identity: d.Identity(), IntentID: "service-intent", Sequence: 1, Lease: d.Lease}
	refresh.Lease.IssuedAt = serverReceived
	refresh.Lease.ExpiresAt = serverReceived.Add(5 * time.Minute)
	tr := &heartbeatCadenceTransport{
		now: now, polls: make(chan struct{}), proceed: make(chan struct{}),
		calls: make(chan scheduledHeartbeat, 4), response: make(chan struct{}),
	}
	switch outcome {
	case "refresh":
		tr.result.PolicyRefresh = &refresh
		tr.onResult = func() { fixture.delayNext.Store(true) }
		handlingCompleted = responseCompleted.Add(100 * time.Millisecond)
	case "transport_error":
		tr.err = errors.New("fixture response failed")
	case "rejected_refresh":
		refresh.Sequence = 0
		tr.result.PolicyRefresh = &refresh
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan error, 1)
	var errorsSeen atomic.Int32
	// Keep the unrelated lease ticker out of the application observation
	// barrier. The blocked-response case separately exercises the real ticker.
	leaseInterval := time.Minute
	if outcome == "blocked_until_expiry" {
		leaseInterval = time.Millisecond
	}
	go func() {
		_, err := RunDriver(ctx, r, tr, nil, DriverOptions{Continuous: true, PollInterval: time.Millisecond, LeaseInterval: leaseInterval, HeartbeatNow: now, OnTransportError: func(error) { errorsSeen.Add(1) }})
		done <- err
	}()
	defer func() {
		cancel()
		select {
		case <-fixture.proceed:
		default:
			close(fixture.proceed)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(12 * time.Second):
			t.Error("driver did not finish bounded cancellation")
		}
	}()
	waitPoll := func() {
		t.Helper()
		select {
		case <-tr.polls:
		case <-ctx.Done():
			t.Fatal("driver did not reach the next poll barrier")
		}
	}
	advancePoll := func(at time.Time) {
		t.Helper()
		clock.Store(at.UnixNano())
		select {
		case tr.proceed <- struct{}{}:
		case <-ctx.Done():
			t.Fatal("driver did not leave the poll barrier")
		}
		waitPoll()
	}
	waitPoll()
	select {
	case tr.proceed <- struct{}{}:
	case <-ctx.Done():
		t.Fatal("driver did not start the initial heartbeat")
	}
	select {
	case call := <-tr.calls:
		if !call.at.Equal(base) || call.fact.PolicyIssuedAt != d.Lease.IssuedAt {
			t.Fatalf("unexpected initial heartbeat: %+v", call)
		}
	case <-ctx.Done():
		t.Fatal("initial heartbeat was not sent")
	}
	if outcome == "blocked_until_expiry" {
		clock.Store(d.Lease.ExpiresAt.UnixNano())
		select {
		case <-fixture.restricted:
		case <-ctx.Done():
			t.Fatal("lease restriction waited for the blocked heartbeat response")
		}
		if ctx.Err() != nil {
			t.Fatal("lease restriction was not observed before the watchdog")
		}
		st := r.State()
		if st.Observed != nil || st.AccessDecision != "lease_expired" {
			t.Fatalf("blocked heartbeat prevented expiry enforcement: %+v", st)
		}
		if ctx.Err() != nil {
			t.Fatal("expiry enforcement completed only after the watchdog")
		}
		select {
		case <-tr.response:
			t.Fatal("response unexpectedly released before expiry enforcement")
		default:
		}
		return // Cancellation must release and join the still-blocked transport.
	}
	clock.Store(responseCompleted.UnixNano())
	close(tr.response)
	if outcome == "refresh" {
		select {
		case <-fixture.entered:
		case <-ctx.Done():
			t.Fatal("refresh did not enter the application observation barrier")
		}
		clock.Store(handlingCompleted.UnixNano())
		close(fixture.proceed)
	}
	waitPoll() // Includes response application before subsequent clock changes.
	early := []time.Time{base.Add(5 * time.Second), serverReceived.Add(5 * time.Second)}
	if outcome == "refresh" {
		early = append(early, responseCompleted.Add(5*time.Second))
	}
	early = append(early, handlingCompleted.Add(5*time.Second).Add(-time.Nanosecond))
	for _, at := range early {
		advancePoll(at)
		select {
		case call := <-tr.calls:
			t.Fatalf("heartbeat sent before the post-response interval: %+v", call)
		default:
		}
	}
	advancePoll(handlingCompleted.Add(5 * time.Second))
	select {
	case call := <-tr.calls:
		if call.at.Before(serverReceived.Add(5*time.Second)) || !call.at.Before(d.Lease.ExpiresAt) {
			t.Fatalf("heartbeat outside service throttle/old-lease window: %+v", call)
		}
		wantIssued := d.Lease.IssuedAt
		if outcome == "refresh" {
			wantIssued = refresh.Lease.IssuedAt
		}
		if call.fact.PolicyIssuedAt != wantIssued || call.fact.Desired != d.Identity() || call.fact.Observed.Identity != d.Identity() || !call.fact.Observed.Known || !call.fact.Observed.Quiescent {
			t.Fatalf("heartbeat did not acknowledge the actual applied policy: %+v", call)
		}
	default:
		t.Fatal("heartbeat was not sent at the post-response interval")
	}
	wantErrors := int32(0)
	if outcome == "transport_error" || outcome == "rejected_refresh" {
		wantErrors = 1
	}
	if errorsSeen.Load() != wantErrors {
		t.Fatalf("transport/application errors = %d, want %d", errorsSeen.Load(), wantErrors)
	}
	if outcome == "refresh" {
		clock.Store(d.Lease.ExpiresAt.Add(time.Nanosecond).UnixNano())
		st, err := r.Recover(context.Background())
		if err != nil || st.Phase != ObservedConformant || st.Observed == nil || st.Observed.Identity != d.Identity() {
			t.Fatalf("acknowledged refresh did not survive the original expiry: %+v %v", st, err)
		}
	}
}
