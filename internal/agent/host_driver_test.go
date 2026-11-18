package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

type hostFixtureUpdate struct {
	manifest controlprotocol.HostAssignments
	err      error
}
type hostFixtureTransport struct {
	updates chan hostFixtureUpdate
	calls   chan int
	count   int
}

func (f *hostFixtureTransport) ReceiveHostAssignments(ctx context.Context) (controlprotocol.HostAssignments, error) {
	f.count++
	select {
	case f.calls <- f.count:
	case <-ctx.Done():
		return controlprotocol.HostAssignments{}, ctx.Err()
	}
	select {
	case update := <-f.updates:
		return update.manifest, update.err
	case <-ctx.Done():
		return controlprotocol.HostAssignments{}, ctx.Err()
	}
}
func hostTestAssignment(id string) controlprotocol.HostAssignment {
	return controlprotocol.HostAssignment{Instance: domain.CoreInstance{ID: id, HostID: "host", AdapterID: "routeweaver/xray", Version: "26.10.31"}, Scope: Scope{NodeID: "host", InstanceID: id, EnrollmentEpoch: "epoch-" + id}, Token: "synthetic-token-" + id}
}
func hostTestManifest(items ...controlprotocol.HostAssignment) controlprotocol.HostAssignments {
	if items == nil {
		items = []controlprotocol.HostAssignment{}
	}
	return controlprotocol.HostAssignments{NodeID: "host", EnrollmentEpoch: "host-epoch", ExpiresAt: time.Now().Add(time.Hour), Instances: items}
}
func hostTestReceive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("host driver event did not arrive")
		var zero T
		return zero
	}
}

func TestHostDriverOwnsMultipleCoresAndDoesNotRestartOnVersionMetadata(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr := &hostFixtureTransport{updates: make(chan hostFixtureUpdate, 4), calls: make(chan int, 8)}
	started, stopped := make(chan Scope, 8), make(chan Scope, 8)
	done := make(chan error, 1)
	go func() {
		done <- RunHostDriver(ctx, tr, HostDriverOptions{NodeID: "host", EnrollmentEpoch: "host-epoch", PollInterval: time.Millisecond, ShutdownTimeout: time.Second, StartInstance: func(ctx context.Context, a controlprotocol.HostAssignment) error {
			started <- a.Scope
			<-ctx.Done()
			stopped <- a.Scope
			return nil
		}})
	}()
	a, b := hostTestAssignment("a"), hostTestAssignment("b")
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(a, b)}
	first, second := hostTestReceive(t, started), hostTestReceive(t, started)
	if first.InstanceID == second.InstanceID {
		t.Fatal("core workers not independent")
	}
	hostTestReceive(t, tr.calls)
	a.Instance.Name = "Renamed"
	a.Instance.Version = "next-reviewed-version"
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(a, b)}
	hostTestReceive(t, tr.calls)
	select {
	case <-started:
		t.Fatal("metadata edit restarted a core")
	default:
	}
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(a)}
	if scope := hostTestReceive(t, stopped); scope.InstanceID != "b" {
		t.Fatal("removed core stopped the wrong worker")
	}
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{err: &TransportError{Status: 401, Code: "revoked"}}
	if err := hostTestReceive(t, done); err == nil {
		t.Fatal("revoked host kept running")
	}
	if scope := hostTestReceive(t, stopped); scope.InstanceID != "a" {
		t.Fatal("remaining core not stopped")
	}
}
func TestHostDriverRejectsPartialAssignmentWithoutStoppingKnownCores(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr := &hostFixtureTransport{updates: make(chan hostFixtureUpdate, 4), calls: make(chan int, 8)}
	started, stopped := make(chan struct{}, 1), make(chan struct{}, 1)
	failures := make(chan error, 1)
	done := make(chan error, 1)
	go func() {
		done <- RunHostDriver(ctx, tr, HostDriverOptions{NodeID: "host", EnrollmentEpoch: "host-epoch", PollInterval: time.Millisecond, ShutdownTimeout: time.Second, OnTransportError: func(err error) { failures <- err }, StartInstance: func(ctx context.Context, a controlprotocol.HostAssignment) error {
			started <- struct{}{}
			<-ctx.Done()
			stopped <- struct{}{}
			return nil
		}})
	}()
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(hostTestAssignment("a"))}
	hostTestReceive(t, started)
	hostTestReceive(t, tr.calls)
	bad := hostTestManifest()
	bad.Instances = nil
	tr.updates <- hostFixtureUpdate{manifest: bad}
	hostTestReceive(t, failures)
	hostTestReceive(t, tr.calls)
	select {
	case <-stopped:
		t.Fatal("partial manifest removed a known core")
	default:
	}
	cancel()
	if err := hostTestReceive(t, done); err != nil {
		t.Fatal(err)
	}
	hostTestReceive(t, stopped)
}
func TestHostDriverAuthorityExpiryCancelsBlockedPollAndCore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr := &hostFixtureTransport{updates: make(chan hostFixtureUpdate, 1), calls: make(chan int, 8)}
	started, stopped := make(chan struct{}, 1), make(chan struct{}, 1)
	done := make(chan error, 1)
	manifest := hostTestManifest(hostTestAssignment("a"))
	manifest.ExpiresAt = time.Now().Add(time.Second)
	go func() {
		done <- RunHostDriver(ctx, tr, HostDriverOptions{NodeID: "host", EnrollmentEpoch: "host-epoch", PollInterval: time.Millisecond, ShutdownTimeout: time.Second, StartInstance: func(ctx context.Context, a controlprotocol.HostAssignment) error {
			started <- struct{}{}
			<-ctx.Done()
			stopped <- struct{}{}
			return nil
		}})
	}()
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: manifest}
	hostTestReceive(t, started)
	hostTestReceive(t, tr.calls)
	if err := hostTestReceive(t, done); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	hostTestReceive(t, stopped)
}

func TestHostDriverReaddedCoreWaitsForOldWorkerToStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr := &hostFixtureTransport{updates: make(chan hostFixtureUpdate, 4), calls: make(chan int, 8)}
	started := make(chan struct{}, 4)
	stopping := make(chan struct{}, 4)
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- RunHostDriver(ctx, tr, HostDriverOptions{NodeID: "host", EnrollmentEpoch: "host-epoch", PollInterval: time.Millisecond, ShutdownTimeout: time.Second, StartInstance: func(ctx context.Context, a controlprotocol.HostAssignment) error {
			started <- struct{}{}
			<-ctx.Done()
			stopping <- struct{}{}
			<-release
			return nil
		}})
	}()
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(hostTestAssignment("a"))}
	hostTestReceive(t, started)
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest()}
	hostTestReceive(t, stopping)
	hostTestReceive(t, tr.calls)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(hostTestAssignment("a"))}
	hostTestReceive(t, tr.calls)
	select {
	case <-started:
		t.Fatal("replacement overlapped the old core worker")
	default:
	}
	close(release)
	tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(hostTestAssignment("a"))}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
restarted:
	for {
		select {
		case <-started:
			break restarted
		case <-tr.calls:
			tr.updates <- hostFixtureUpdate{manifest: hostTestManifest(hostTestAssignment("a"))}
		case <-deadline.C:
			t.Fatal("readded core did not restart after quiescence")
		}
	}
	cancel()
	if err := hostTestReceive(t, done); err != nil {
		t.Fatal(err)
	}
}
