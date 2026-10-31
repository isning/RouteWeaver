package httpapi_test

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Required by scripts/managed-runtime.sh. A skip is not native-service evidence.
func TestNativeContinuousManagedServicePreservesPayloadAndRevocation(t *testing.T) {
	binary := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	if binary == "" {
		t.Skip("explicit managed native executable required")
	}
	f, user, port := managedServiceFixture(t)
	f, _, token, d := continuousFixtureFrom(t, f)
	ageContinuousLease(t, f, &d)
	d.Lease.IssuedAt = time.Now().UTC().Add(-285 * time.Second)
	d.Lease.ExpiresAt = d.Lease.IssuedAt.Add(300 * time.Second)
	if err := f.s.Put("agent-desired", d.InstanceID, d); err != nil {
		t.Fatal(err)
	}
	var intent map[string]any
	if err := f.s.Get("agent-service-intents", d.InstanceID, &intent); err != nil {
		t.Fatal(err)
	}
	intent["lease"] = d.Lease
	intent["validationNotBefore"] = time.Now().UTC().Add(time.Second)
	if err := f.s.Put("agent-service-intents", d.InstanceID, intent); err != nil {
		t.Fatal(err)
	}
	var manifest domain.PublishedManifest
	if err := f.s.Get("published-manifests", d.RevisionID, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.PolicyExpiresAt = d.Lease.ExpiresAt
	if err := f.s.Put("published-manifests", d.RevisionID, manifest); err != nil {
		t.Fatal(err)
	}

	root, err := os.MkdirTemp("", "rw-service-native-")
	if err != nil {
		t.Fatal(err)
	}
	retain := false
	t.Cleanup(func() {
		if !retain {
			os.RemoveAll(root)
		}
	})
	contents, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary = filepath.Join(root, "managed-core")
	if err = os.WriteFile(binary, contents, 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := agent.NewNativeChecker(d.AdapterID, d.CoreVersion, binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	reconciler, err := agent.Open(root, d.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	spool, err := agent.OpenMeterSpool(filepath.Join(root, "meters"), d.Scope, "native-service-test")
	if err != nil {
		t.Fatal(err)
	}
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: f.srv.URL, Scope: d.Scope, Token: token, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := agent.RunDriver(ctx, reconciler, transport, spool, agent.DriverOptions{Continuous: true, PollInterval: 50 * time.Millisecond, LeaseInterval: 50 * time.Millisecond})
		done <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				retain = true
				t.Errorf("native service cleanup: %v; evidence %s", err, root)
			}
		case <-time.After(10 * time.Second):
			retain = true
			t.Errorf("native service shutdown timeout; evidence %s", root)
		}
		spool.Close()
		reconciler.Close()
		transport.Close()
	})
	deadline := time.Now().Add(8 * time.Second)
	for {
		fact, e := reconciler.ServiceHeartbeat(context.Background())
		var reported agent.State
		f.s.Get("agent-observations", d.InstanceID, &reported)
		if e == nil && fact.Observed.Identity == d.Identity() && reported.Observed != nil && reported.Observed.Identity == d.Identity() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native continuous driver did not activate original identity")
		}
		time.Sleep(20 * time.Millisecond)
	}
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	uuid := "00000000-0000-4000-8000-000000000011"
	dial := func() (net.Conn, error) {
		c, e := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
		if e != nil {
			return nil, e
		}
		c.SetDeadline(time.Now().Add(2 * time.Second))
		credential, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
		target := echo.Addr().(*net.TCPAddr).Port
		header := append([]byte{0}, credential...)
		header = append(header, 0, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
		header = append(header, []byte("before-renewal")...)
		if _, e = c.Write(header); e != nil {
			c.Close()
			return nil, e
		}
		got := make([]byte, 2+len("before-renewal"))
		_, e = io.ReadFull(c, got)
		if e != nil {
			c.Close()
			return nil, e
		}
		if string(got[2:]) != "before-renewal" {
			c.Close()
			return nil, errors.New("native payload mismatch")
		}
		return c, nil
	}
	conn, err := dial()
	if err != nil {
		t.Fatal("real managed admission failed:", err)
	}
	defer conn.Close()
	// The flow exists before the independent instance refresh, and must retain
	// only its own bounded admission authority throughout renewal.
	fact, err := reconciler.ServiceHeartbeat(context.Background())
	if err != nil || fact.PolicyIssuedAt != d.Lease.IssuedAt {
		t.Fatal("flow was not opened before instance refresh", err)
	}
	deadline = time.Now().Add(8 * time.Second)
	for {
		fact, err = reconciler.ServiceHeartbeat(context.Background())
		if err == nil && fact.PolicyIssuedAt.After(d.Lease.IssuedAt) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native continuous driver did not apply refresh")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if wait := time.Until(d.Lease.ExpiresAt.Add(200 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	payload := []byte("after-original-instance-lease")
	if _, err = conn.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(conn, got); err != nil || string(got) != string(payload) {
		t.Fatalf("payload did not cross original instance expiry: %q %v", got, err)
	}
	obs, err := supervisor.Observe(context.Background(), root)
	if err != nil || obs.Identity != d.Identity() {
		t.Fatal("instance renewal replaced native identity")
	}
	if code, _, raw := req(t, operatorClient(), "DELETE", f.srv.URL+"/api/users/"+user.id+"/entries/alice-entry", "", nil); code != 200 {
		t.Fatal(code, raw)
	}
	// The refreshed instance lease must not authorize this revoked principal.
	if denied, e := dial(); e == nil {
		denied.Close()
		t.Fatal("revoked principal obtained a new native flow")
	}
	deadline = time.Now().Add(entrypolicy.MaxLease + 3*time.Second)
	closed := false
	for time.Now().Before(deadline) {
		conn.SetDeadline(time.Now().Add(time.Second))
		_, e := conn.Write([]byte("x"))
		if e == nil {
			var b [1]byte
			_, e = io.ReadFull(conn, b[:])
		}
		if e != nil {
			if timeout, ok := e.(net.Error); !ok || !timeout.Timeout() {
				closed = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !closed {
		t.Fatal("existing revoked flow outlived its own bounded admission lease")
	}
	obs, err = supervisor.Observe(context.Background(), root)
	if err != nil || obs.Identity != d.Identity() {
		t.Fatal("revocation test only passed because whole runtime exited")
	}
}
