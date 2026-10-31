package managedxray_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/mux"
	xnet "github.com/xtls/xray-core/common/net"
	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

type leaseService struct {
	mu              sync.Mutex
	leases          map[string]entrypolicy.AdmissionRequest
	denied          bool
	fail            bool
	ttl             time.Duration
	rate            int64
	connectionLimit int
}

func newLeaseService(rate int64) *leaseService {
	return &leaseService{leases: map[string]entrypolicy.AdmissionRequest{}, ttl: 30 * time.Second, rate: rate}
}
func (a *leaseService) Acquire(ctx context.Context, r entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.fail {
		return entrypolicy.Lease{}, errors.New("unavailable")
	}
	if a.denied {
		return entrypolicy.Lease{Reason: "account_disabled"}, nil
	}
	ips := map[string]bool{}
	for _, v := range a.leases {
		ips[v.ClientIP] = true
	}
	if !ips[r.ClientIP] && len(ips) >= 1 {
		return entrypolicy.Lease{Reason: "ip_limit"}, nil
	}
	if _, existing := a.leases[r.PresenceID]; !existing && a.connectionLimit > 0 && len(a.leases) >= a.connectionLimit {
		return entrypolicy.Lease{Reason: "connection-limit"}, nil
	}
	a.leases[r.PresenceID] = r
	return entrypolicy.Lease{Allowed: true, LeaseID: r.PresenceID, AccountID: "account-1", RouteID: "route-1", ExpiresAt: time.Now().Add(a.ttl), EntryRateBPS: a.rate}, nil
}
func (a *leaseService) Release(ctx context.Context, id string) error {
	a.mu.Lock()
	delete(a.leases, id)
	a.mu.Unlock()
	return nil
}
func freePort(t *testing.T) int {
	t.Helper()
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
func tlsFixture(t *testing.T) ([]string, []string, *tls.Config) {
	t.Helper()
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), DNSNames: []string{"localhost"}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	priv := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(cert)
	return []string{string(cert)}, []string{string(priv)}, &tls.Config{ServerName: "localhost", RootCAs: pool, MinVersion: tls.VersionTLS12}
}
func start(t *testing.T, a entrypolicy.Admission, encrypted bool) (*managed.Runtime, int, int, int, *tls.Config) {
	return startWithOptions(t, a, encrypted, managed.Options{})
}
func startWithOptions(t *testing.T, a entrypolicy.Admission, encrypted bool, options managed.Options) (*managed.Runtime, int, int, int, *tls.Config) {
	t.Helper()
	echo, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	var conns sync.Map
	t.Cleanup(func() { echo.Close(); conns.Range(func(k, v any) bool { k.(net.Conn).Close(); return true }) })
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			conns.Store(c, true)
			go func() { defer conns.Delete(c); defer c.Close(); io.Copy(c, c) }()
		}
	}()
	p1, p2 := freePort(t), freePort(t)
	var raw map[string]any
	json.Unmarshal(config(p1), &raw)
	ins := raw["inbounds"].([]any)
	first := ins[0].(map[string]any)
	var clientTLS *tls.Config
	if encrypted {
		cert, key, c := tlsFixture(t)
		clientTLS = c
		first["streamSettings"] = map[string]any{"network": "tcp", "security": "tls", "tlsSettings": map[string]any{"certificates": []any{map[string]any{"certificate": cert, "key": key}}}}
	}
	secondRaw, _ := json.Marshal(first)
	var second map[string]any
	json.Unmarshal(secondRaw, &second)
	second["tag"] = "public-b"
	second["port"] = p2
	raw["inbounds"] = append(ins, second)
	native, _ := json.Marshal(raw)
	d := descriptor()
	d.DestinationPolicy.AllowCIDRs = []string{"127.0.0.1/32"}
	b := d.Bindings[0]
	b.InboundTag = "public-b"
	b.EntryID = "entry-2"
	d.Bindings = append(d.Bindings, b)
	r, e := managed.NewWithOptions(native, d, a, options)
	if e != nil {
		t.Fatal(e)
	}
	if e = r.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close() })
	return r, p1, p2, echo.Addr().(*net.TCPAddr).Port, clientTLS
}

var uuidBytes = []byte{0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}

func dialVLESS(t *testing.T, p, target int, ip string, isMux bool, tlsConfig *tls.Config) net.Conn {
	t.Helper()
	c, e := (&net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(ip)}}).Dial("tcp", fmt.Sprintf("127.0.0.1:%d", p))
	if e != nil {
		t.Fatal(e)
	}
	if tlsConfig != nil {
		c = tls.Client(c, tlsConfig)
		if e := c.(*tls.Conn).Handshake(); e != nil {
			t.Fatal(e)
		}
	}
	h := append([]byte{0}, uuidBytes...)
	h = append(h, 0)
	if isMux {
		h = append(h, 3)
	} else {
		h = append(h, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
	}
	if _, e = c.Write(h); e != nil {
		t.Fatal(e)
	}
	return c
}
func roundtrip(c net.Conn, p []byte, first bool) error {
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, e := c.Write(p); e != nil {
		return e
	}
	if first {
		h := make([]byte, 2)
		if _, e := io.ReadFull(c, h); e != nil {
			return e
		}
		if !bytes.Equal(h, []byte{0, 0}) {
			return errors.New("invalid VLESS response")
		}
	}
	b := make([]byte, len(p))
	_, e := io.ReadFull(c, b)
	if e == nil && !bytes.Equal(b, p) {
		return errors.New("payload mismatch")
	}
	return e
}
func total(r *managed.Runtime) uint64 {
	var n uint64
	for _, c := range r.Snapshot().Counters {
		n += c.CumulativeBytes
	}
	return n
}
func eventually(t *testing.T, f func() bool) {
	t.Helper()
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		if f() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func TestNativeVLESSTCPAndTLSSharedDuplexRateUnionAndAccountRevoke(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(fmt.Sprintf("tls=%t", encrypted), func(t *testing.T) {
			a := newLeaseService(65536)
			r, p1, p2, target, tlsConfig := start(t, a, encrypted)
			c1 := dialVLESS(t, p1, target, "127.0.0.2", false, tlsConfig)
			defer c1.Close()
			c2 := dialVLESS(t, p1, target, "127.0.0.2", false, tlsConfig)
			defer c2.Close()
			c3 := dialVLESS(t, p2, target, "127.0.0.2", false, tlsConfig)
			defer c3.Close()
			for _, c := range []net.Conn{c1, c2, c3} {
				if e := roundtrip(c, []byte("ok"), true); e != nil {
					t.Fatal(e)
				}
			}
			other := dialVLESS(t, p2, target, "127.0.0.3", false, tlsConfig)
			defer other.Close()
			if roundtrip(other, []byte("deny"), true) == nil {
				t.Fatal("new IP at global cap allowed")
			}
			before := total(r)
			payload := bytes.Repeat([]byte("x"), 32768)
			begin := time.Now()
			errs := make(chan error, 2)
			go func() { errs <- roundtrip(c1, payload, false) }()
			go func() { errs <- roundtrip(c2, payload, false) }()
			for i := 0; i < 2; i++ {
				if e := <-errs; e != nil {
					t.Fatal(e)
				}
			}
			elapsed := time.Since(begin)
			if got := total(r) - before; got != 131072 {
				t.Fatalf("duplex bytes=%d", got)
			}
			if elapsed < 1800*time.Millisecond || elapsed > 5*time.Second {
				t.Fatalf("shared rate elapsed=%s", elapsed)
			}
			begin = time.Now()
			r.RevokeAccount("account-1")
			if roundtrip(c1, []byte("deny"), false) == nil {
				t.Fatal("old flow survived revoke")
			}
			if roundtrip(c3, []byte("deny"), false) == nil {
				t.Fatal("other entry survived account revoke")
			}
			newer := dialVLESS(t, p1, target, "127.0.0.2", false, tlsConfig)
			defer newer.Close()
			if roundtrip(newer, []byte("deny"), true) == nil {
				t.Fatal("new flow survived revoke")
			}
			eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
			t.Logf("payload=131072B aggregate rate64KiB/s+4KiB burst elapsed=%s revoke payload denial=%s", elapsed, time.Since(begin))
		})
	}
}
func muxWrite(c net.Conn, id uint16, status mux.SessionStatus, target int, p []byte) error {
	b := buf.New()
	defer b.Release()
	m := mux.FrameMetadata{SessionID: id, SessionStatus: status, Option: mux.OptionData, Target: xnet.TCPDestination(xnet.ParseAddress("127.0.0.1"), xnet.Port(target))}
	if e := m.WriteTo(b); e != nil {
		return e
	}
	h := append([]byte{}, b.Bytes()...)
	h = append(h, byte(len(p)>>8), byte(len(p)))
	h = append(h, p...)
	_, e := c.Write(h)
	return e
}
func muxRead(c net.Conn, id uint16, want []byte, first bool) error {
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if first {
		h := make([]byte, 2)
		if _, e := io.ReadFull(c, h); e != nil {
			return e
		}
	}
	var got []byte
	for len(got) < len(want) {
		var m mux.FrameMetadata
		if e := m.Unmarshal(c, false); e != nil {
			return e
		}
		if m.Option.Has(mux.OptionData) {
			var n uint16
			if e := binary.Read(c, binary.BigEndian, &n); e != nil {
				return e
			}
			b := make([]byte, n)
			if _, e := io.ReadFull(c, b); e != nil {
				return e
			}
			if m.SessionID == id {
				got = append(got, b...)
			}
		}
		if m.SessionID == id && m.SessionStatus == mux.SessionStatusEnd {
			return errors.New("stream ended")
		}
	}
	if !bytes.Equal(got, want) {
		return errors.New("mux payload mismatch")
	}
	return nil
}
func TestNativeMuxRetainedAuthenticationCannotResumeAfterRevocation(t *testing.T) {
	a := newLeaseService(0)
	r, p, _, target, tlsConfig := start(t, a, true)
	c := dialVLESS(t, p, target, "127.0.0.2", true, tlsConfig)
	defer c.Close()
	msg := []byte("before revoke")
	if e := muxWrite(c, 1, mux.SessionStatusNew, target, msg); e != nil {
		t.Fatal(e)
	}
	if e := muxRead(c, 1, msg, true); e != nil {
		t.Fatal(e)
	}
	r.RevokeAccount("account-1")
	before := total(r)
	rejected := r.Snapshot().RejectedFlows
	c.SetWriteDeadline(time.Now().Add(time.Second))
	if e := muxWrite(c, 2, mux.SessionStatusNew, target, []byte("forbidden new stream")); e != nil {
		t.Fatalf("retained auth carrier unexpectedly closed: %v", e)
	}
	eventually(t, func() bool { return r.Snapshot().RejectedFlows > rejected })
	_ = muxWrite(c, 1, mux.SessionStatusKeep, target, []byte("forbidden old stream"))
	if total(r) != before {
		t.Fatal("post revoke bytes admitted")
	}
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
}
func TestLeaseExpiryEndsPayloadWithoutAgentPoll(t *testing.T) {
	a := newLeaseService(0)
	a.ttl = 250 * time.Millisecond
	r, p, _, target, _ := start(t, a, false)
	c := dialVLESS(t, p, target, "127.0.0.2", false, nil)
	defer c.Close()
	if e := roundtrip(c, []byte("ok"), true); e != nil {
		t.Fatal(e)
	}
	a.mu.Lock()
	a.fail = true
	a.mu.Unlock()
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
	if roundtrip(c, []byte("deny"), false) == nil {
		t.Fatal("lease expiry did not close existing payload")
	}
}
func TestMuxNaturalCloseReleasesPresence(t *testing.T) {
	a := newLeaseService(0)
	r, p, _, target, _ := start(t, a, false)
	c := dialVLESS(t, p, target, "127.0.0.2", true, nil)
	defer c.Close()
	msg := []byte("ok")
	if e := muxWrite(c, 1, mux.SessionStatusNew, target, msg); e != nil {
		t.Fatal(e)
	}
	if e := muxRead(c, 1, msg, true); e != nil {
		t.Fatal(e)
	}
	if e := muxWrite(c, 1, mux.SessionStatusEnd, target, nil); e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
	eventually(t, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return len(a.leases) == 0 })
}

type delayedAdmission struct {
	base    *leaseService
	entered chan struct{}
	allow   chan struct{}
	once    sync.Once
}

func (a *delayedAdmission) Acquire(ctx context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	if !q.Final {
		a.once.Do(func() { close(a.entered); <-a.allow })
	}
	return a.base.Acquire(ctx, q)
}
func (a *delayedAdmission) Release(ctx context.Context, id string) error {
	return a.base.Release(ctx, id)
}
func TestOutstandingAllowCannotResurrectRevokedAccount(t *testing.T) {
	a := &delayedAdmission{base: newLeaseService(0), entered: make(chan struct{}), allow: make(chan struct{})}
	r, p, _, target, _ := start(t, a, false)
	c := dialVLESS(t, p, target, "127.0.0.2", false, nil)
	defer c.Close()
	done := make(chan error, 1)
	go func() { done <- roundtrip(c, []byte("forbidden"), true) }()
	<-a.entered
	r.RevokeAccount("account-1")
	close(a.allow)
	if e := <-done; e == nil {
		t.Fatal("delayed allow resurrected revoked account")
	}
	if total(r) != 0 || r.Snapshot().ActiveFlows != 0 {
		t.Fatal("revoked account got a registered flow or payload")
	}
}

type fixedBudgetAdmission struct {
	base   *leaseService
	mu     sync.Mutex
	budget uint64
	final  uint64
}

func (a *fixedBudgetAdmission) Acquire(ctx context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	l, e := a.base.Acquire(ctx, q)
	a.mu.Lock()
	defer a.mu.Unlock()
	if q.Final {
		a.final = q.AdmittedBytes
	}
	budget := a.budget
	l.ByteBudget = &budget
	return l, e
}
func (a *fixedBudgetAdmission) Release(ctx context.Context, id string) error {
	return a.base.Release(ctx, id)
}
func TestFinitePayloadReservationCapsCombinedDirectionsBeforeNextPoll(t *testing.T) {
	a := &fixedBudgetAdmission{base: newLeaseService(0), budget: 25}
	r, p, _, target, tlsConfig := start(t, a, true)
	c := dialVLESS(t, p, target, "127.0.0.2", false, tlsConfig)
	defer c.Close()
	if e := roundtrip(c, []byte("0123456789"), true); e != nil {
		t.Fatal(e)
	}
	if e := roundtrip(c, []byte("0123456789"), false); e == nil {
		t.Fatal("payload exceeded25-byte combined quota")
	}
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
	if got := total(r); got != 25 {
		t.Fatalf("admitted bytes=%d want exact25 ceiling", got)
	}
	eventually(t, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.final == 25 })
}

func TestNativeEntryDeniesPrivateDestinationByDefault(t *testing.T) {
	// A listener may bind loopback for a fixture without making loopback an
	// authorized user destination. The default policy must deny before admission.
	port := freePort(t)
	a := newLeaseService(0)
	r, err := managed.New(config(port), descriptor(), a)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err = r.Start(); err != nil {
		t.Fatal(err)
	}
	c := dialVLESS(t, port, port, "127.0.0.2", false, nil)
	defer c.Close()
	if roundtrip(c, []byte("private destination"), true) == nil {
		t.Fatal("default private destination policy allowed payload")
	}
	if total(r) != 0 {
		t.Fatal("denied destination was metered as admitted")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.leases) != 0 {
		t.Fatal("denied destination consumed an admission lease")
	}
}

func TestNativeVLESSDomainUsesSingleValidatedPinnedResolution(t *testing.T) {
	resolver := &answerResolver{answers: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}
	r, port, _, target, _ := startWithOptions(t, newLeaseService(0), false, managed.Options{DestinationResolver: resolver})
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	host := "does-not-exist.invalid"
	h := append([]byte{0}, uuidBytes...)
	h = append(h, 0, 1, byte(target>>8), byte(target), 2, byte(len(host)))
	h = append(h, host...)
	if _, err = c.Write(h); err != nil {
		t.Fatal(err)
	}
	if err = roundtrip(c, []byte("pinned"), true); err != nil {
		t.Fatal("native re-resolved or dropped approved domain target:", err)
	}
	if total(r) != 12 {
		t.Fatalf("unexpected admitted bytes: %d", total(r))
	}
	c.Close()
	eventually(t, func() bool { return r.Snapshot().ActiveFlows == 0 })
	if resolver.calls != 1 {
		t.Fatalf("destination resolved %d times", resolver.calls)
	}
}

func TestMuxConnectionCapDeniesOnlyNewStream(t *testing.T) {
	a := newLeaseService(0)
	a.connectionLimit = 1
	r, p, _, target, _ := start(t, a, false)
	c := dialVLESS(t, p, target, "127.0.0.2", true, nil)
	defer c.Close()
	if e := muxWrite(c, 1, mux.SessionStatusNew, target, []byte("first")); e != nil {
		t.Fatal(e)
	}
	if e := muxRead(c, 1, []byte("first"), true); e != nil {
		t.Fatal(e)
	}
	if e := muxWrite(c, 2, mux.SessionStatusNew, target, []byte("denied")); e != nil {
		t.Fatal(e)
	}
	if e := muxRead(c, 2, []byte("denied"), false); e == nil {
		t.Fatal("extra mux stream admitted")
	}
	if e := muxWrite(c, 1, mux.SessionStatusKeep, target, []byte("existing")); e != nil {
		t.Fatal(e)
	}
	if e := muxRead(c, 1, []byte("existing"), false); e != nil {
		t.Fatalf("denied new stream killed already admitted stream: %v", e)
	}
	if r.Snapshot().ActiveFlows != 1 {
		t.Fatal("existing stream lost lease")
	}
}
