package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestOutboundTransportPreservesCancellationDuringResponseBody(t *testing.T) {
	d := testDesired(t, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var requests atomic.Int32
	tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: "http://127.0.0.1", Token: "synthetic-cancellation-token", Scope: d.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 3, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	finished := make(chan struct{})
	tr.transport.DialContext = func(context.Context, string, string) (net.Conn, error) {
		requests.Add(1)
		client, server := net.Pipe()
		go func() {
			defer close(finished)
			defer server.Close()
			if _, err := http.ReadRequest(bufio.NewReader(server)); err != nil {
				return
			}
			_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
			// A separate unbuffered write completes only once the caller starts
			// reading the body, rather than racing header receipt in client.Do.
			_, _ = io.WriteString(server, "{")
			cancel()
			_, _ = io.Copy(io.Discard, server)
		}()
		return client, nil
	}
	if got, err := tr.ReceiveDesired(ctx, d.Scope, 0); got != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted body must preserve cancellation without a desired command: got %v, %v", got, err)
	}
	<-finished
	if requests.Load() != 1 {
		t.Fatal("caller cancellation started another request")
	}
}

func TestOutboundTransportRetriesInterruptedMeterReceiptWithSameBatch(t *testing.T) {
	d := testDesired(t, 1)
	batch := MeterBatch{Scope: d.Scope, StreamEpoch: "synthetic-stream", Sequence: 7, Digest: "synthetic-batch-digest"}
	type received struct{ body, key string }
	requests := make(chan received, 2)
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		requests <- received{string(body), r.Header.Get("Idempotency-Key")}
		if attempts.Add(1) == 1 {
			// The remote side accepted the batch, but its response is truncated.
			w.Header().Set("Content-Length", "1000")
			_, _ = io.WriteString(w, `{"streamEpoch":`)
			return
		}
		_ = json.NewEncoder(w).Encode(MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest})
	}))
	defer server.Close()
	tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "synthetic-retry-token", Scope: d.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	receipt, err := tr.SendMeterBatch(context.Background(), batch)
	if err != nil || receipt.Sequence != 7 || attempts.Load() != 2 {
		t.Fatalf("interrupted receipt did not recover within retry budget: receipt=%+v err=%v attempts=%d", receipt, err, attempts.Load())
	}
	first, retry := <-requests, <-requests
	if first.key == "" || first != retry {
		t.Fatal("receipt retry changed the batch or its idempotency identity")
	}
}

func TestOutboundTransportInterruptedResponsesRespectRetryAndAuthorizationBounds(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		calls  int32
	}{{"retry exhaustion", http.StatusOK, 2}, {"unauthorized", http.StatusUnauthorized, 1}, {"redirect", http.StatusTemporaryRedirect, 1}} {
		t.Run(scenario.name, func(t *testing.T) {
			d := testDesired(t, 1)
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Length", "1000")
				w.WriteHeader(scenario.status)
				_, _ = io.WriteString(w, "{")
			}))
			defer server.Close()
			tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "synthetic-bounded-retry-token", Scope: d.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 2, Backoff: time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			defer tr.Close()
			got, err := tr.ReceiveDesired(context.Background(), d.Scope, 0)
			var transportErr *TransportError
			if got != nil || !errors.As(err, &transportErr) || transportErr.Code != "response_read_failed" || transportErr.Status != scenario.status || calls.Load() != scenario.calls {
				t.Fatalf("interrupted response escaped its retry boundary: result=%v error=%v requests=%d", got, err, calls.Load())
			}
		})
	}
}
