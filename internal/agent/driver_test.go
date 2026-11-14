package agent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type driverTransport struct {
	mu      sync.Mutex
	desired *Desired
	reports []State
	batches []MeterBatch
}

func (t *driverTransport) ReceiveDesired(ctx context.Context, s Scope, after uint64) (*Desired, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.desired != nil && t.desired.Generation > after {
		d := *t.desired
		return &d, nil
	}
	return nil, nil
}
func (t *driverTransport) ReportObservation(_ context.Context, _ Scope, s State) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.reports = append(t.reports, s)
	return nil
}
func (t *driverTransport) SendMeterBatch(_ context.Context, b MeterBatch) (MeterReceipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.batches = append(t.batches, b)
	return MeterReceipt{StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest}, nil
}
func TestBoundedDriverReconcilesReportsAndStopsOwnedSession(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	tr := &driverTransport{desired: &d}
	st, err := RunDriver(context.Background(), r, tr, nil, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, MaxRuntime: 80 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != "stopped" || st.Observed != nil {
		t.Fatalf("session not stopped: %+v", st)
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	found := false
	for _, report := range tr.reports {
		found = found || report.Phase == ObservedConformant
	}
	if !found {
		t.Fatal("no observed status report")
	}
}

// blockedLeaseTransport never completes a poll until the driver is cancelled.
// Unlike a sleep, this proves restriction occurs before the network returns.
type blockedLeaseTransport struct {
	driverTransport
	entered           chan struct{}
	restricted        <-chan struct{}
	restrictedAtEntry bool
}

func (t *blockedLeaseTransport) ReceiveDesired(ctx context.Context, _ Scope, _ uint64) (*Desired, error) {
	select {
	case <-t.restricted:
		t.restrictedAtEntry = true
	default:
	}
	close(t.entered)
	<-ctx.Done()
	return nil, ctx.Err()
}

type signalledLeaseFixture struct {
	LocalFixture
	restricted chan struct{}
	once       sync.Once
}

func (f *signalledLeaseFixture) Restrict(ctx context.Context, root string) error {
	if err := f.LocalFixture.Restrict(ctx, root); err != nil {
		return err
	}
	f.once.Do(func() { close(f.restricted) })
	return nil
}

func TestSlowControlPlaneCannotDelayLeaseRestriction(t *testing.T) {
	for _, expiredAtStartup := range []bool{false, true} {
		t.Run(fmt.Sprintf("expired_at_startup=%t", expiredAtStartup), func(t *testing.T) {
			testBlockedPollLeaseRestriction(t, expiredAtStartup)
		})
	}
}

func testBlockedPollLeaseRestriction(t *testing.T, expiredAtStartup bool) {
	t.Helper()
	d := testDesired(t, 1)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	d.Lease.ExpiresAt = time.Unix(0, clock.Load()).Add(30 * time.Millisecond)
	fixture := &signalledLeaseFixture{restricted: make(chan struct{})}
	root := filepath.Join(t.TempDir(), "agent")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, d.Scope, NewRegistry(fixture), Options{
		MaxLease: 2 * time.Hour,
		Now:      func() time.Time { return time.Unix(0, clock.Load()) },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if expiredAtStartup {
		clock.Store(d.Lease.ExpiresAt.UnixNano())
	}
	tr := &blockedLeaseTransport{entered: make(chan struct{}), restricted: fixture.restricted}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := RunDriver(ctx, r, tr, nil, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, Continuous: true})
		done <- err
	}()
	// Always join before closing the reconciler, including assertion failures.
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-tr.entered:
	case <-time.After(time.Second):
		t.Fatal("driver never entered the blocked control-plane poll")
	}
	if expiredAtStartup && !tr.restrictedAtEntry {
		t.Fatal("startup recovery entered network polling before restricting the expired runtime")
	}
	// Expire the same 30 ms policy only after startup and the network barrier.
	// This clock controls policy time, not the driver's real lease ticker.
	clock.Store(d.Lease.ExpiresAt.UnixNano())
	select {
	case <-fixture.restricted:
	case <-time.After(time.Second):
		t.Fatal("lease restriction waited for the blocked control-plane poll")
	}
	st := r.State()
	if st.Observed != nil || st.AccessDecision != "lease_expired" {
		t.Fatalf("blocked poll prevented expiry enforcement: %+v", st)
	}
}

func TestBoundedDriverIntegratesTLSDesiredObservationAndMeterReceipt(t *testing.T) {
	d := testDesired(t, 1)
	r := openTest(t, t.TempDir(), LocalFixture{})
	meter, err := OpenMeterSpool(filepath.Join(t.TempDir(), "meter"), d.Scope, "outbox-1")
	if err != nil {
		t.Fatal(err)
	}
	defer meter.Close()
	_, err = meter.Enqueue([]MeterSample{{SampleID: "entry-sample", CounterEpoch: "native-epoch", SubjectID: "fixture-user", RouteID: "fixture-route", PolicyRevision: "fixture-policy", CycleID: "fixture-cycle", MeasurementLayer: "entry_payload", CumulativeBytes: 10, ObservedAt: time.Now()}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var completed atomic.Bool
	var observed atomic.Bool
	var receivedMeter atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer fixture-scope-token" {
			t.Error("missing fixture auth")
			w.WriteHeader(401)
			return
		}
		switch {
		case strings.HasSuffix(req.URL.Path, "/desired"):
			// A subsequent poll follows both observation delivery and local Ack
			// of the exact meter receipt. Stop on that event, not on a deadline
			// that races TLS, reconciliation, or durable spool writes on CI.
			if observed.Load() && receivedMeter.Load() && len(meter.Pending()) == 0 {
				completed.Store(true)
				w.WriteHeader(204)
				cancel()
				return
			}
			if req.URL.Query().Get("after") == "0" {
				json.NewEncoder(w).Encode(d)
			} else {
				w.WriteHeader(204)
			}
		case strings.HasSuffix(req.URL.Path, "/observations"):
			var st State
			if err := json.NewDecoder(req.Body).Decode(&st); err != nil {
				t.Error(err)
			}
			if st.Phase == ObservedConformant {
				observed.Store(true)
			}
			w.WriteHeader(204)
		case strings.HasSuffix(req.URL.Path, "/meter-batches"):
			var batch MeterBatch
			if err := json.NewDecoder(req.Body).Decode(&batch); err != nil {
				t.Error(err)
			}
			receivedMeter.Store(true)
			json.NewEncoder(w).Encode(MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "fixture-scope-token", Scope: d.Scope, RootCAs: roots, RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	st, err := RunDriver(ctx, r, transport, meter, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, MaxRuntime: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != "stopped" || !completed.Load() || !observed.Load() || !receivedMeter.Load() || len(meter.Pending()) != 0 {
		t.Fatalf("incomplete TLS driver integration: %+v", st)
	}
}

func TestDriverContinuousModeIsExplicitAndExclusive(t *testing.T) {
	for _, options := range []DriverOptions{
		{PollInterval: time.Millisecond, LeaseInterval: time.Millisecond},
		{PollInterval: time.Millisecond, LeaseInterval: time.Millisecond, Continuous: true, MaxRuntime: time.Second},
		{PollInterval: time.Millisecond, LeaseInterval: time.Millisecond, MaxRuntime: 25 * time.Hour},
	} {
		r := openTest(t, t.TempDir(), LocalFixture{})
		if _, err := RunDriver(context.Background(), r, &driverTransport{}, nil, options); err == nil {
			t.Fatal("ambiguous or unbounded default accepted")
		}
	}
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		st, err := RunDriver(ctx, r, &driverTransport{}, nil, DriverOptions{Continuous: true, PollInterval: time.Millisecond, LeaseInterval: time.Millisecond})
		if err == nil && (st.Phase != "stopped" || st.Observed != nil) {
			err = fmt.Errorf("owned session not stopped: %+v", st)
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("service exited without cancellation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("service failed to stop")
	}
}

type restartFenceTransport struct {
	driverTransport
	polled     bool
	firstAfter uint64
	delivered  bool
	onReport   func(State)
}

func (tr *restartFenceTransport) ReceiveDesired(ctx context.Context, scope Scope, after uint64) (*Desired, error) {
	if !tr.polled {
		tr.polled = true
		tr.firstAfter = after
	}
	desired, err := tr.driverTransport.ReceiveDesired(ctx, scope, after)
	tr.delivered = tr.delivered || desired != nil
	return desired, err
}

func (tr *restartFenceTransport) ReportObservation(ctx context.Context, scope Scope, st State) error {
	if err := tr.driverTransport.ReportObservation(ctx, scope, st); err != nil {
		return err
	}
	tr.onReport(st)
	return nil
}

func runRestartFencePhase(t *testing.T, phase string, r *Reconciler, desired Desired, after uint64, delivered bool) State {
	t.Helper()
	// The watchdog bounds failure, not successful activation. Each phase ends
	// at its first in-loop report, so an erroneous report cannot be retried away.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var report *State
	tr := &restartFenceTransport{driverTransport: driverTransport{desired: &desired}}
	tr.onReport = func(st State) {
		// The final shutdown report uses a fresh context and must not satisfy
		// the phase if cancellation happened before any in-loop report.
		if ctx.Err() != nil || report != nil {
			return
		}
		observed := copyState(st)
		report = &observed
		cancel()
	}
	final, err := RunDriver(ctx, r, tr, nil, DriverOptions{PollInterval: time.Millisecond, LeaseInterval: time.Millisecond, Continuous: true})
	if err != nil {
		t.Fatalf("%s driver: %v", phase, err)
	}
	// RunDriver has joined the transport before these callback fields are read.
	if report == nil {
		t.Fatalf("%s did not produce an in-loop report: final_phase=%s final_code=%s", phase, final.Phase, final.Code)
	}
	if !tr.polled || tr.firstAfter != after || tr.delivered != delivered {
		t.Fatalf("%s generation poll: polled=%t after=%d delivered=%t; want after=%d delivered=%t", phase, tr.polled, tr.firstAfter, tr.delivered, after, delivered)
	}
	if report.HighestAccepted != desired.Generation || report.Desired == nil || *report.Desired != desired.Identity() {
		t.Fatalf("%s report lost the accepted generation fence: highest=%d desired=%v", phase, report.HighestAccepted, report.Desired)
	}
	if final.Phase != "stopped" || final.Code != "local_session_stopped" || final.Observed != nil || final.RecoveryRequired || final.HighestAccepted != desired.Generation || final.Desired == nil || *final.Desired != desired.Identity() || final.LastKnownValid == nil || *final.LastKnownValid != desired.Identity() {
		t.Fatalf("%s did not stop the exact accepted session: phase=%s code=%s highest=%d observed=%t recovery_required=%t", phase, final.Phase, final.Code, final.HighestAccepted, final.Observed != nil, final.RecoveryRequired)
	}
	return *report
}

func TestDriverRestartRetainsGenerationFenceUntilNewDesired(t *testing.T) {
	root := t.TempDir()
	d := testDesired(t, 1)
	r := openTest(t, root, LocalFixture{})
	initial := runRestartFencePhase(t, "initial generation", r, d, 0, true)
	if initial.Phase != ObservedConformant || initial.Observed == nil || !initial.Observed.Known || !initial.Observed.Quiescent || initial.Observed.Identity != d.Identity() || initial.RecoveryRequired {
		t.Fatalf("initial generation was not observed active: phase=%s code=%s observed=%v", initial.Phase, initial.Code, initial.Observed)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	r = openTest(t, root, LocalFixture{})
	if retained := r.State(); retained.HighestAccepted != 1 || retained.Desired == nil || *retained.Desired != d.Identity() {
		t.Fatalf("reopen lost the durable generation fence: highest=%d desired=%v", retained.HighestAccepted, retained.Desired)
	}
	old := runRestartFencePhase(t, "reopened old generation", r, d, 1, false)
	if old.Phase != "stopped" || old.Code != "local_session_stopped" || old.Observed != nil || old.RecoveryRequired {
		t.Fatalf("restart replayed the stopped generation: phase=%s code=%s observed=%v", old.Phase, old.Code, old.Observed)
	}
	d.Generation = 2
	d.OperationID = "restart-authorized-operation"
	newer := runRestartFencePhase(t, "new desired generation", r, d, 1, true)
	if newer.Phase != ObservedConformant || newer.Observed == nil || !newer.Observed.Known || !newer.Observed.Quiescent || newer.Observed.Identity != d.Identity() || newer.RecoveryRequired {
		t.Fatalf("new desired generation did not authorize restart: phase=%s code=%s observed=%v", newer.Phase, newer.Code, newer.Observed)
	}
}
