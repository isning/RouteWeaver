package agent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	slow    bool
}

func (t *driverTransport) ReceiveDesired(ctx context.Context, s Scope, after uint64) (*Desired, error) {
	if t.slow {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
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
func TestSlowControlPlaneCannotDelayLeaseRestriction(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	d.Lease.ExpiresAt = time.Now().Add(30 * time.Millisecond)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	tr := &driverTransport{slow: true}
	done := make(chan error, 1)
	go func() {
		_, err := RunDriver(context.Background(), r, tr, nil, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, MaxRuntime: 200 * time.Millisecond})
		done <- err
	}()
	time.Sleep(70 * time.Millisecond)
	st := r.State()
	if st.Observed != nil || st.AccessDecision != "lease_expired" {
		t.Fatalf("slow poll blocked expiry enforcement: %+v", st)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
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
	st, err := RunDriver(context.Background(), r, transport, meter, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, MaxRuntime: 80 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != "stopped" || !observed.Load() || !receivedMeter.Load() || len(meter.Pending()) != 0 {
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

func TestDriverRestartRetainsGenerationFenceUntilNewDesired(t *testing.T) {
	root := t.TempDir()
	d := testDesired(t, 1)
	options := DriverOptions{PollInterval: time.Millisecond, LeaseInterval: time.Millisecond, MaxRuntime: 30 * time.Millisecond}
	r := openTest(t, root, LocalFixture{})
	if _, err := RunDriver(context.Background(), r, &driverTransport{desired: &d}, nil, options); err != nil {
		t.Fatal(err)
	}
	r.Close()
	r = openTest(t, root, LocalFixture{})
	old := &driverTransport{desired: &d}
	if _, err := RunDriver(context.Background(), r, old, nil, options); err != nil {
		t.Fatal(err)
	}
	for _, report := range old.reports {
		if report.Phase == ObservedConformant {
			t.Fatal("restart replayed stopped generation")
		}
	}
	d.Generation = 2
	d.OperationID = "restart-authorized-operation"
	newer := &driverTransport{desired: &d}
	if _, err := RunDriver(context.Background(), r, newer, nil, options); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, report := range newer.reports {
		found = found || (report.Phase == ObservedConformant && report.Observed != nil && report.Observed.Generation == 2)
	}
	if !found {
		t.Fatal("new desired generation did not authorize restart")
	}
}
