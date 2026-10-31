package privateipc_test

import (
	"context"
	"encoding/binary"
	"io"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/privateipc"
	"sync"
	"testing"
	"time"
)

func pair() (*privateipc.Duplex, *privateipc.Duplex) {
	ar, aw := io.Pipe()
	br, bw := io.Pipe()
	return privateipc.NewDuplex(ar, bw), privateipc.NewDuplex(br, aw)
}

type authority struct{}

func (authority) Acquire(_ context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	budget := uint64(25)
	return entrypolicy.Lease{Allowed: true, LeaseID: q.PresenceID, AccountID: "account", RouteID: "route", ByteBudget: &budget}, nil
}
func (authority) Release(context.Context, string) error { return nil }
func TestPrivateAdmissionTypedRoundtripAndEOF(t *testing.T) {
	a, b := pair()
	defer a.Close()
	defer b.Close()
	go privateipc.ServeAdmission(b, authority{})
	client := privateipc.NewAdmissionClient(a)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	lease, e := client.Acquire(ctx, entrypolicy.AdmissionRequest{PresenceID: "presence"})
	if e != nil || lease.LeaseID != "presence" || lease.ByteBudget == nil || *lease.ByteBudget != 25 {
		t.Fatalf("lease=%+v error=%v", lease, e)
	}
	b.Close()
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Fatal("inherited channel EOF was not exposed")
	}
}
func TestCancelledCallCannotRaceReturnedValueOrGrowUnbounded(t *testing.T) {
	a, b := pair()
	defer a.Close()
	defer b.Close()
	client := privateipc.NewAdmissionClient(a)
	defer client.Close()
	// The peer reads no requests, so sends cannot finish. Cancellation must still
	// return while only the fixed number of send workers can remain outstanding.
	var wg sync.WaitGroup
	for i := 0; i < 96; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
			defer cancel()
			if _, e := client.Acquire(ctx, entrypolicy.AdmissionRequest{PresenceID: "presence"}); e == nil {
				t.Error("stalled peer unexpectedly granted")
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled admission calls failed to return")
	}
	// Closing the peer must unblock every retained sender and make later calls fail.
	b.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, e := client.Acquire(ctx, entrypolicy.AdmissionRequest{}); e == nil {
		t.Fatal("closed channel granted")
	}
}
func TestUnknownDuplicateAndOversizedFramesCloseChannel(t *testing.T) {
	for _, raw := range []string{
		`{"version":1,"method":"Admission.Acquire","sequence":1,"body":{"Request":{"PresenceID":"x","command":"shell"}}}`,
		`{"version":1,"Version":1,"method":"Admission.Acquire","sequence":1,"body":{}}`,
		`{"version":2,"method":"Admission.Acquire","sequence":1,"body":{}}`,
	} {
		a, b := pair()
		go privateipc.ServeAdmission(b, authority{})
		go func() {
			defer a.Close()
			binary.Write(a, binary.BigEndian, uint32(len(raw)))
			io.WriteString(a, raw)
			io.Copy(io.Discard, a)
		}()
		select {
		case <-b.Done():
		case <-time.After(time.Second):
			t.Fatal("invalid frame did not close channel")
		}
	}
	a, b := pair()
	defer a.Close()
	go privateipc.ServeAdmission(b, authority{})
	go binary.Write(a, binary.BigEndian, uint32(16385))
	select {
	case <-b.Done():
	case <-time.After(time.Second):
		t.Fatal("oversized frame did not close channel")
	}
}

type shortWriter struct{ io.WriteCloser }

func (w shortWriter) Write(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return w.WriteCloser.Write(p)
}
func TestShortPipeWritesPreserveFraming(t *testing.T) {
	ar, aw := io.Pipe()
	br, bw := io.Pipe()
	a := privateipc.NewDuplex(ar, shortWriter{bw})
	b := privateipc.NewDuplex(br, shortWriter{aw})
	defer a.Close()
	defer b.Close()
	go privateipc.ServeAdmission(b, authority{})
	client := privateipc.NewAdmissionClient(a)
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, e := client.Acquire(ctx, entrypolicy.AdmissionRequest{PresenceID: "p"}); e != nil {
		t.Fatal(e)
	}
}
