package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/privateipc"
)

// This is an on-disk adapter simulation with real inherited-pipe RPC, not
// native-process or traffic evidence. Assertions cross the RunDriver seam.
type shutdownCollectionFixture struct {
	LocalFixture
	snapshot            entrypolicy.Snapshot
	collecting          chan struct{}
	releaseSnapshot     chan struct{}
	observing           chan struct{}
	releaseObservation  chan struct{}
	collected           sync.Once
	released            sync.Once
	observationHeld     atomic.Bool
	pipes               *ProcessIO
	child               *privateipc.Duplex
	controlDone         chan struct{}
	finalCollectionFail bool
}

func (f *shutdownCollectionFixture) Descriptor() Descriptor {
	return Descriptor{ID: ManagedXrayID, Version: ManagedXrayVersion, CanActivate: true, Evidence: "local_fixture_only"}
}

func (f *shutdownCollectionFixture) Activate(ctx context.Context, st Staged) error {
	if err := f.LocalFixture.Activate(ctx, st); err != nil {
		return err
	}
	pipes, err := prepareManagedPipes(st)
	if err != nil {
		return err
	}
	f.pipes = pipes
	f.child = privateipc.NewDuplex(pipes.ExtraFiles[2], pipes.ExtraFiles[3])
	f.controlDone = make(chan struct{})
	go func() {
		defer close(f.controlDone)
		privateipc.ServeControl(f.child, f)
	}()
	return nil
}

func (f *shutdownCollectionFixture) Snapshot() entrypolicy.Snapshot {
	f.collected.Do(func() { close(f.collecting) })
	<-f.releaseSnapshot
	return f.snapshot
}

func (*shutdownCollectionFixture) RevokeAccount(string) {}

func (f *shutdownCollectionFixture) Observe(ctx context.Context, root string) (Observation, error) {
	select {
	case <-f.collecting:
		if f.observationHeld.CompareAndSwap(false, true) {
			close(f.observing)
			<-f.releaseObservation
		}
	default:
	}
	return f.LocalFixture.Observe(ctx, root)
}

func (f *shutdownCollectionFixture) Restrict(ctx context.Context, root string) error {
	f.released.Do(func() { close(f.releaseSnapshot) })
	if err := f.LocalFixture.Restrict(ctx, root); err != nil {
		return err
	}
	if f.finalCollectionFail {
		// Introduce a real journal decode failure only after the run worker
		// has joined, so only the fresh-context final collection can find it.
		return os.WriteFile(filepath.Join(ManagedJournalDirectory(root), "bad.baseline.json"), []byte("{"), 0600)
	}
	return nil
}

func (f *shutdownCollectionFixture) close(ctx context.Context) error {
	f.released.Do(func() { close(f.releaseSnapshot) })
	if f.pipes != nil {
		f.pipes.OnExit()
	}
	if f.child != nil {
		f.child.Close()
		select {
		case <-f.controlDone:
		case <-ctx.Done():
			return errors.New("fixture control server did not join")
		}
	}
	return nil
}

type shutdownCollectionTransport struct{ driverTransport }

func (*shutdownCollectionTransport) Acquire(context.Context, entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{}, errors.New("fixture does not admit traffic")
}

func (*shutdownCollectionTransport) Release(context.Context, string) error { return nil }

type shutdownCollectionResult struct {
	state State
	err   error
}

func TestDriverCancellationDuringManagedCollection(t *testing.T) {
	// Barriers fix the lifecycle ordering. The old driver's choice between
	// two ready select cases is still schedule-dependent, so exercise it more
	// than once rather than claiming a deterministic pre-fix failure.
	for attempt := 0; attempt < 32; attempt++ {
		t.Run(fmt.Sprintf("attempt_%02d", attempt), func(t *testing.T) {
			testDriverManagedCollectionShutdown(t, false, false)
		})
	}
}

func TestDriverPreservesGenuineManagedCollectionFailure(t *testing.T) {
	testDriverManagedCollectionShutdown(t, true, false)
}

func TestDriverPreservesFinalCollectionFailureAfterCancellation(t *testing.T) {
	testDriverManagedCollectionShutdown(t, false, true)
}

func testDriverManagedCollectionShutdown(t *testing.T, initialFailure, finalFailure bool) {
	t.Helper()
	d := testDesired(t, 1)
	d.AdapterID, d.CoreVersion = ManagedXrayID, ManagedXrayVersion
	fixture := &shutdownCollectionFixture{
		snapshot:            retentionSnapshot(time.Now().UTC(), "shutdown-epoch", 1, 0),
		collecting:          make(chan struct{}),
		releaseSnapshot:     make(chan struct{}),
		observing:           make(chan struct{}),
		releaseObservation:  make(chan struct{}),
		finalCollectionFail: finalFailure,
	}
	root, err := os.MkdirTemp("", "rw-driver-shutdown-")
	if err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, d.Scope, NewRegistry(fixture), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		os.RemoveAll(root)
		t.Fatal(err)
	}
	spool, err := OpenMeterSpool(filepath.Join(root, "spool"), d.Scope, "shutdown-test")
	if err != nil {
		r.Close()
		os.RemoveAll(root)
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan shutdownCollectionResult, 1)
	var barrierDone chan error
	var barrierCancel context.CancelFunc
	var release sync.Once
	releaseObservation := func() { release.Do(func() { close(fixture.releaseObservation) }) }
	started, joined, barrierJoined := false, false, false
	defer func() {
		cancel()
		if barrierCancel != nil {
			barrierCancel()
		}
		releaseObservation()
		fixture.released.Do(func() { close(fixture.releaseSnapshot) })
		cleanupCtx, stop := context.WithTimeout(context.Background(), 12*time.Second)
		defer stop()
		quiescent := true
		if started && !joined {
			select {
			case <-done:
			case <-cleanupCtx.Done():
				t.Error("driver did not join during test cleanup")
				quiescent = false
			}
		}
		if barrierDone != nil && !barrierJoined {
			select {
			case <-barrierDone:
			case <-cleanupCtx.Done():
				t.Error("barrier collector did not join during test cleanup")
				quiescent = false
			}
		}
		if !quiescent {
			// Do not close locks or remove files still owned by an unjoined
			// goroutine. Unlike t.TempDir, this root survives failed cleanup.
			t.Logf("shutdown fixture retained: %s", root)
			return
		}
		if err := fixture.close(cleanupCtx); err != nil {
			t.Errorf("%v; fixture retained: %s", err, root)
			return
		}
		if err := spool.Close(); err != nil {
			t.Error(err)
		}
		if err := r.Close(); err != nil {
			t.Error(err)
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	}()
	writeRetentionSnapshot(t, root, "baseline", fixture.snapshot)
	if initialFailure {
		if err := os.WriteFile(filepath.Join(ManagedJournalDirectory(root), "bad.baseline.json"), []byte("{"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	tr := &shutdownCollectionTransport{driverTransport: driverTransport{desired: &d}}
	started = true
	go func() {
		state, err := RunDriver(ctx, r, tr, spool, DriverOptions{Continuous: true, PollInterval: time.Millisecond, LeaseInterval: time.Millisecond})
		done <- shutdownCollectionResult{state: state, err: err}
	}()
	wait := func(ch <-chan struct{}, message string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatal(message)
		}
	}
	if !initialFailure {
		wait(fixture.collecting, "driver did not enter live counter collection")
		wait(fixture.observing, "driver did not enter the observation barrier")
		cancel()
		// The public collector serializes with the interrupted collection.
		// Reading the same retained zero again changes no counter or receipt;
		// its return proves the worker released collection before the main
		// driver resumes. No private channel or collection hook is inspected.
		barrierCtx, stop := context.WithCancel(context.Background())
		barrierCancel = stop
		barrierDone = make(chan error, 1)
		go func() { barrierDone <- CollectManagedCounters(barrierCtx, root, spool, false) }()
		// The collector's ordinary mutex is not context-aware. This select
		// bounds the wait even if that mutex is never released; cleanup first
		// releases every fixture barrier, then joins both goroutines.
		select {
		case barrierErr := <-barrierDone:
			barrierJoined = true
			stop()
			if barrierErr != nil {
				t.Fatalf("retained baseline unavailable after interrupted collection: %v", barrierErr)
			}
		case <-time.After(5 * time.Second):
			stop()
			t.Fatal("barrier collector did not finish after cancellation")
		}
		releaseObservation()
	}
	var result shutdownCollectionResult
	select {
	case result = <-done:
		joined = true
	case <-time.After(12 * time.Second):
		t.Fatal("driver did not complete bounded shutdown")
	}
	if initialFailure || finalFailure {
		var syntax *json.SyntaxError
		if !errors.As(result.err, &syntax) {
			t.Fatalf("genuine journal failure was lost: %v", result.err)
		}
		if initialFailure && ctx.Err() != nil {
			t.Fatal("collection failure only surfaced after parent cancellation")
		}
	} else {
		if result.err != nil {
			t.Fatalf("parent cancellation became a collection failure: %v", result.err)
		}
		if len(spool.Pending()) != 0 {
			t.Fatal("successful shutdown left an unacknowledged meter batch")
		}
		tr.mu.Lock()
		batches := len(tr.batches)
		tr.mu.Unlock()
		if batches == 0 {
			t.Fatal("shutdown did not deliver the retained baseline")
		}
	}
	if result.state.Phase != "stopped" || result.state.Observed != nil || result.state.RecoveryRequired {
		t.Fatalf("owned stop was not conclusive: %+v", result.state)
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if len(tr.reports) == 0 || tr.reports[len(tr.reports)-1].Phase != "stopped" {
		t.Fatal("shutdown did not report the actual stopped state")
	}
}
