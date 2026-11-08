package managedxray_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf"
	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

type detourAdmission struct {
	base           *leaseService
	mu             sync.Mutex
	requests       map[string]entrypolicy.AdmissionRequest
	finalAttempts  map[string]uint64
	acceptedFinals map[string]uint64
	budget         *uint64
}

func newDetourAdmission() *detourAdmission {
	return &detourAdmission{base: newLeaseService(0), requests: map[string]entrypolicy.AdmissionRequest{}, finalAttempts: map[string]uint64{}, acceptedFinals: map[string]uint64{}}
}

func (a *detourAdmission) Acquire(ctx context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	a.mu.Lock()
	a.requests[q.PresenceID] = q
	if q.Final {
		a.finalAttempts[q.PresenceID] = q.AdmittedBytes
	}
	a.mu.Unlock()
	l, err := a.base.Acquire(ctx, q)
	if q.Final && err == nil && l.Allowed {
		a.mu.Lock()
		a.acceptedFinals[q.PresenceID] = q.AdmittedBytes
		a.mu.Unlock()
	}
	l.ByteBudget = a.budget
	return l, err
}

func (a *detourAdmission) Release(ctx context.Context, id string) error {
	return a.base.Release(ctx, id)
}

// Each stock proxy uses the same pinned, unchanged native module as production.
// Only the entry runtime owns admission and payload accounting.
func startDetourStockProxy(t *testing.T) int {
	t.Helper()
	port := freePort(t)
	var native conf.Config
	if err := json.Unmarshal(config(port), &native); err != nil {
		t.Fatal(err)
	}
	built, err := native.Build()
	if err != nil {
		t.Fatal(err)
	}
	r, err := core.New(built)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	if err := r.Start(); err != nil {
		t.Fatal(err)
	}
	return port
}

type detourTarget struct {
	port     int
	accepted atomic.Uint64
	received atomic.Uint64
	active   atomic.Int64
}

func startDetourTarget(t *testing.T, relayPort int) *detourTarget {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	observed := &detourTarget{port: l.Addr().(*net.TCPAddr).Port}
	var conns sync.Map
	t.Cleanup(func() {
		l.Close()
		conns.Range(func(key, _ any) bool { key.(net.Conn).Close(); return true })
	})
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			observed.accepted.Add(1)
			observed.active.Add(1)
			conns.Store(c, true)
			go func() {
				defer c.Close()
				defer conns.Delete(c)
				defer observed.active.Add(-1)
				if relayPort != 0 {
					upstream, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", relayPort), time.Second)
					if err != nil {
						return
					}
					defer upstream.Close()
					done := make(chan struct{})
					go func() { io.Copy(upstream, c); upstream.Close(); close(done) }()
					io.Copy(c, upstream)
					c.Close()
					<-done
					return
				}
				buf := make([]byte, 4096)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						observed.received.Add(uint64(n))
						if _, writeErr := c.Write(buf[:n]); writeErr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	return observed
}

func startManagedDetour(t *testing.T, admission entrypolicy.Admission, allowPrivate bool, resolver managed.DestinationResolver) (*managed.Runtime, int, *detourTarget, *detourTarget, *managed.Journal, string) {
	t.Helper()
	first := startDetourStockProxy(t)
	middle := startDetourStockProxy(t)
	last := startDetourStockProxy(t)
	connector := startDetourTarget(t, first)
	target := startDetourTarget(t, 0)
	port := freePort(t)
	outbounds := []any{
		detourOutbound("last", "middle", "vless", last),
		detourOutbound("middle", "first", "vless", middle),
		detourOutbound("first", "", "vless", connector.port),
	}
	d := descriptor()
	if allowPrivate {
		d.DestinationPolicy.AllowCIDRs = []string{"127.0.0.1/32"}
	}
	r, err := managed.NewWithOptions(detourConfig(t, port, outbounds), d, admission, managed.Options{DestinationResolver: resolver})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	dir := filepath.Join(t.TempDir(), "journal")
	journal, err := managed.BeginJournal(dir, r.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Start(); err != nil {
		t.Fatal(err)
	}
	return r, port, connector, target, journal, dir
}

func assertDetourFinal(t *testing.T, r *managed.Runtime, a *detourAdmission, journal *managed.Journal, dir string, upload, download uint64, acceptedFinal bool) {
	t.Helper()
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	final := r.Snapshot()
	if final.ActiveFlows != 0 || len(final.Counters) != 1 {
		t.Fatalf("wrong final flow attribution: %+v", final)
	}
	counter := final.Counters[0]
	if counter.UploadBytes != upload || counter.DownloadBytes != download || counter.CumulativeBytes != upload+download || counter.AccountID != "account-1" || counter.RouteID != "route-1" || counter.EntryID != "entry-1" || counter.SubjectID != "opaque-subject" || counter.MeasurementLayer != entrypolicy.MeasurementLayer {
		t.Fatalf("detour changed payload accounting: %+v", counter)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.requests) != 1 || len(a.finalAttempts) != 1 {
		t.Fatalf("detours created extra logical admissions or lost the final attempt: requests=%+v finalAttempts=%+v", a.requests, a.finalAttempts)
	}
	for id, request := range a.requests {
		if request.ClientIP != "127.0.0.2" || request.EntryID != "entry-1" || request.SubjectID != "opaque-subject" || request.CredentialVersion != "credential-1" || a.finalAttempts[id] != upload+download {
			t.Fatalf("detour changed physical principal or final admitted bytes: %+v final=%d", request, a.finalAttempts[id])
		}
	}
	wantAccepted := 0
	if acceptedFinal {
		wantAccepted = 1
	}
	if len(a.acceptedFinals) != wantAccepted {
		t.Fatalf("accepted final count=%d want %d; attempts are not settlements", len(a.acceptedFinals), wantAccepted)
	}
	for _, admitted := range a.acceptedFinals {
		if admitted != upload+download {
			t.Fatalf("accepted final bytes=%d want %d", admitted, upload+download)
		}
	}
	if err := journal.Finish(final); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, final.CounterEpoch+".final.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted entrypolicy.Snapshot
	if err = json.Unmarshal(b, &persisted); err != nil || !reflect.DeepEqual(final, persisted) {
		t.Fatalf("detour final journal mismatch: %v: %+v", err, persisted)
	}
}

func waitDetourTransportCleanup(t *testing.T, r *managed.Runtime, connector, target *detourTarget, upload, download uint64) time.Duration {
	t.Helper()
	// The pinned upstream has a one-second DownlinkOnly timeout. Its two
	// context.WithoutCancel redirects and three stock proxy handlers may drain
	// serially after EOF, so socket recycling is distinct from payload cutoff.
	// Allow those five timers plus one second of scheduling margin. Never close
	// the runtime to manufacture cleanup; enforce the frozen payload gate on
	// every observation while already-admitted bytes may still reach the target.
	const detourLayers = 2
	const stockProxyLayers = 3
	const halfCloseTimeout = time.Second
	budget := (detourLayers+stockProxyLayers)*halfCloseTimeout + time.Second
	started := time.Now()
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		snapshot := r.Snapshot()
		if snapshot.ActiveFlows != 0 || len(snapshot.Counters) != 1 || snapshot.Counters[0].UploadBytes != upload || snapshot.Counters[0].DownloadBytes != download || snapshot.Counters[0].CumulativeBytes != upload+download {
			t.Fatalf("payload gate changed during transport cleanup: %+v", snapshot)
		}
		if received := target.received.Load(); received > upload {
			t.Fatalf("transport delivered %d bytes beyond the frozen %d-byte upload gate", received, upload)
		}
		if target.active.Load() == 0 && connector.active.Load() == 0 {
			return time.Since(started)
		}
		select {
		case <-deadline.C:
			t.Fatalf("payload stopped but transport cleanup exceeded %s: target=%d connector=%d", budget, target.active.Load(), connector.active.Load())
		case <-poll.C:
		}
	}
}

func TestNativeTwoDetoursPreserveSingleAdmissionAccountingAndCutoff(t *testing.T) {
	for _, cutoff := range []string{"revoke", "lease expiry", "byte budget"} {
		t.Run(cutoff, func(t *testing.T) {
			a := newDetourAdmission()
			if cutoff == "lease expiry" {
				a.base.ttl = time.Second
			}
			if cutoff == "byte budget" {
				budget := uint64(16389)
				a.budget = &budget
			}
			r, port, connector, target, journal, dir := startManagedDetour(t, a, true, nil)
			c := dialVLESS(t, port, target.port, "127.0.0.2", false, nil)
			defer c.Close()
			payload := bytes.Repeat([]byte("p"), 8192)
			if err := roundtrip(c, payload, true); err != nil {
				t.Fatal(err)
			}
			if total(r) != 16384 || target.received.Load() != 8192 || connector.accepted.Load() != 1 || r.Snapshot().ActiveFlows != 1 {
				t.Fatalf("detoured payload not counted once: snapshot=%+v target=%d connector=%d", r.Snapshot(), target.received.Load(), connector.accepted.Load())
			}
			wantUpload, wantDownload := uint64(8192), uint64(8192)
			cutoffStarted := time.Now()
			switch cutoff {
			case "revoke":
				r.RevokeAccount("account-1")
			case "lease expiry":
				// No successful final settlement is possible while the authority
				// stays unavailable. The durable journal retains those exact bytes.
				a.base.mu.Lock()
				a.base.fail = true
				a.base.mu.Unlock()
				eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
			case "byte budget":
				if err := roundtrip(c, payload, false); err == nil {
					t.Fatal("two detours bypassed the combined byte ceiling")
				}
				wantUpload = 8197
			}
			eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
			if err := roundtrip(c, []byte("forbidden after cutoff"), false); err == nil {
				t.Fatal("existing two-detour stream survived cutoff")
			}
			cutoffElapsed := time.Since(cutoffStarted)
			cleanupElapsed := waitDetourTransportCleanup(t, r, connector, target, wantUpload, wantDownload)
			before := target.received.Load()
			if before > wantUpload {
				t.Fatalf("target received %d bytes beyond %d admitted upload", before, wantUpload)
			}
			_ = roundtrip(c, []byte("still forbidden"), false)
			if target.received.Load() != before || total(r) != wantUpload+wantDownload {
				t.Fatal("post-cutoff payload reached target or changed counters")
			}
			t.Logf("payload cutoff=%s; subsequent transport cleanup=%s; frozen admitted payload=%dB", cutoffElapsed, cleanupElapsed, wantUpload+wantDownload)
			assertDetourFinal(t, r, a, journal, dir, wantUpload, wantDownload, cutoff != "lease expiry")
		})
	}
}

func TestNativeTwoDetoursDoNotBypassDestinationOrAdmissionDenial(t *testing.T) {
	for _, denied := range []string{"private IP", "private DNS", "packet destination", "admission"} {
		t.Run(denied, func(t *testing.T) {
			a := newDetourAdmission()
			a.base.denied = denied == "admission"
			resolver := &answerResolver{answers: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}
			r, port, connector, target, _, _ := startManagedDetour(t, a, denied == "admission" || denied == "packet destination", resolver)
			c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			command := byte(1)
			if denied == "packet destination" {
				command = 2
			}
			h := append([]byte{0}, uuidBytes...)
			h = append(h, 0, command, byte(target.port>>8), byte(target.port))
			if denied == "private DNS" {
				host := "blocked.invalid"
				h = append(h, 2, byte(len(host)))
				h = append(h, host...)
			} else {
				h = append(h, 1, 127, 0, 0, 1)
			}
			if _, err = c.Write(h); err != nil {
				t.Fatal(err)
			}
			if err = roundtrip(c, []byte("must not leave entry"), true); err == nil {
				t.Fatal("denied request reached target")
			}
			if err = r.Close(); err != nil {
				t.Fatal(err)
			}
			if connector.accepted.Load() != 0 || target.accepted.Load() != 0 || total(r) != 0 {
				t.Fatal("denied request opened a connector or admitted payload")
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			if denied != "admission" && len(a.requests) != 0 {
				t.Fatal("destination denial happened after admission")
			}
			if denied == "admission" && len(a.requests) != 1 {
				t.Fatal("admission denial was not exercised")
			}
		})
	}
}

func TestNativeTwoDetoursRevokeInterruptsRateQueuedPayload(t *testing.T) {
	a := newDetourAdmission()
	a.base.rate = 1024
	r, port, connector, target, journal, dir := startManagedDetour(t, a, true, nil)
	c := dialVLESS(t, port, target.port, "127.0.0.2", false, nil)
	defer c.Close()
	if err := roundtrip(c, bytes.Repeat([]byte("w"), 32), true); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- roundtrip(c, bytes.Repeat([]byte("q"), 32768), false) }()
	eventually(t, func() bool { return r.Snapshot().Counters[0].UploadBytes > 32 })
	// Revocation runs while a larger write is still rate queued, not just
	// between two requests on an idle connection. Via contexts cannot resume it.
	cutoffStarted := time.Now()
	r.RevokeAccount("account-1")
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("queued payload completed after revocation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revocation did not interrupt queued payload")
	}
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
	if err := roundtrip(c, []byte("forbidden before transport cleanup"), false); err == nil {
		t.Fatal("revoked queued stream accepted more payload")
	}
	cutoffElapsed := time.Since(cutoffStarted)
	final := r.Snapshot().Counters[0]
	if final.UploadBytes <= 32 || final.UploadBytes >= 32800 || target.received.Load() > final.UploadBytes {
		t.Fatalf("rate-queued payload escaped revocation: counter=%+v target=%d", final, target.received.Load())
	}
	cleanupElapsed := waitDetourTransportCleanup(t, r, connector, target, final.UploadBytes, final.DownloadBytes)
	before := target.received.Load()
	_ = roundtrip(c, []byte("forbidden queued continuation"), false)
	if target.received.Load() != before {
		t.Fatal("revoked queued payload resumed on the target")
	}
	t.Logf("queued payload cutoff=%s; subsequent transport cleanup=%s; frozen admitted payload=%dB", cutoffElapsed, cleanupElapsed, final.CumulativeBytes)
	assertDetourFinal(t, r, a, journal, dir, final.UploadBytes, final.DownloadBytes, true)
}
