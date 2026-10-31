package agent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOutboundTransportIsScopedAuthenticatedBoundedAndRetryable(t *testing.T) {
	d := testDesired(t, 5)
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-operator-supplied-token" || r.Header.Get("X-RouteWeaver-Node") != d.NodeID || r.Header.Get("X-RouteWeaver-Enrollment") != d.EnrollmentEpoch {
			t.Error("missing scoped authentication")
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/agent/instances/core-a/desired":
			if calls.Add(1) == 1 {
				w.WriteHeader(503)
				return
			}
			if r.URL.Query().Get("after") != "4" {
				t.Error("wrong desired generation cursor")
			}
			json.NewEncoder(w).Encode(d)
		case "/api/agent/instances/core-a/observations":
			if r.Method != "POST" || r.Header.Get("Idempotency-Key") == "" {
				t.Error("missing observation idempotency")
			}
			w.WriteHeader(204)
		case "/api/agent/instances/core-a/meter-batches":
			var b MeterBatch
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				t.Error(err)
			}
			json.NewEncoder(w).Encode(MeterReceipt{StreamEpoch: b.StreamEpoch, Sequence: b.Sequence, Digest: b.Digest})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "fixture-operator-supplied-token", Scope: d.Scope, RootCAs: roots, RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	got, err := transport.ReceiveDesired(context.Background(), d.Scope, 4)
	if err != nil || got.Generation != 5 || calls.Load() != 2 {
		t.Fatalf("poll: %+v %v calls %d", got, err, calls.Load())
	}
	identity := d.Identity()
	if err = transport.ReportObservation(context.Background(), d.Scope, State{HighestAccepted: 5, Desired: &identity, Phase: Accepted}); err != nil {
		t.Fatal(err)
	}
	receipt, err := transport.SendMeterBatch(context.Background(), MeterBatch{Scope: d.Scope, StreamEpoch: "test", Sequence: 1, Digest: "fixture-digest"})
	if err != nil || receipt.Sequence != 1 {
		t.Fatalf("meter: %+v %v", receipt, err)
	}
}
func TestOutboundTransportRejectsInsecureAndWrongScope(t *testing.T) {
	d := testDesired(t, 1)
	for _, url := range []string{"http://example.com", "http://127.0.0.1:1", "https://user:password@example.com", "https://example.com/?token=secret"} {
		if _, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: url, Token: "fixture", Scope: d.Scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond}); err == nil {
			t.Fatalf("unsafe URL accepted: %s", url)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("wrong-scope request reached server") }))
	defer server.Close()
	tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "fixture", Scope: d.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	foreign := d.Scope
	foreign.InstanceID = "other"
	if _, err = tr.ReceiveDesired(context.Background(), foreign, 0); err == nil {
		t.Fatal("foreign scope allowed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = tr.ReceiveDesired(ctx, d.Scope, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestOutboundTransportDoesNotForwardTokenOnRedirect(t *testing.T) {
	d := testDesired(t, 1)
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer other.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	roots := x509.NewCertPool()
	roots.AddCert(source.Certificate())
	tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: source.URL, Token: "PRIVATE_FIXTURE_TOKEN", Scope: d.Scope, RootCAs: roots, RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if _, err = tr.ReceiveDesired(context.Background(), d.Scope, 0); err == nil || leaked.Load() {
		t.Fatal("redirect was followed")
	}
	if strings.Contains(err.Error(), "PRIVATE_FIXTURE_TOKEN") || strings.Contains(err.Error(), other.URL) {
		t.Fatal("transport leaked credentials or response content")
	}
}
func TestOutboundTransportRejectsUnknownWireBehaviorAndWrongMeterReceipt(t *testing.T) {
	d := testDesired(t, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/desired") {
			io.WriteString(w, `{"unexpectedNativeOverride":"secret"}`)
		} else {
			io.WriteString(w, `{"streamEpoch":"other","sequence":"2","digest":"different"}`)
		}
	}))
	defer server.Close()
	tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "fixture", Scope: d.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	if _, err = tr.ReceiveDesired(context.Background(), d.Scope, 0); err == nil {
		t.Fatal("unknown behavior-bearing field accepted")
	}
	if _, err = tr.SendMeterBatch(context.Background(), MeterBatch{Scope: d.Scope, StreamEpoch: "expected", Sequence: 1, Digest: "expected"}); err == nil {
		t.Fatal("wrong meter receipt accepted")
	}
}
