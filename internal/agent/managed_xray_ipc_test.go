//go:build linux

package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"routeweaver/internal/entrypolicy"
	"testing"
	"time"
)

type brokerAuthority struct{}

func (brokerAuthority) Acquire(ctx context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{Allowed: true, LeaseID: q.PresenceID, AccountID: "account", RouteID: "route", ExpiresAt: time.Now().Add(30 * time.Second)}, nil
}
func (brokerAuthority) Release(context.Context, string) error { return nil }
func privateShortRoot(t *testing.T) string {
	t.Helper()
	dir, e := os.MkdirTemp("", "rw-agent-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}
func TestPrivateAdmissionBrokerHasOnlyBoundedLeaseOperations(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_UNIX_SOCKET_TESTS") != "1" {
		t.Skip("optional Unix transport needs explicit native socket-test opt-in; inherited-pipe tests remain mandatory")
	}

	root := privateShortRoot(t)
	broker, e := StartUnixAdmissionBroker(root, brokerAuthority{})
	if e != nil {
		t.Fatal(e)
	}
	defer broker.Close()
	st, e := os.Stat(ManagedAdmissionSocket(root))
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("socket permissions: %v %v", st, e)
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", ManagedAdmissionSocket(root))
	}}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: time.Second}
	req := entrypolicy.AdmissionRequest{EntryID: "entry", SubjectID: "opaque", CredentialVersion: "credential", ClientIP: "127.0.0.2", PresenceID: "presence"}
	body, _ := json.Marshal(req)
	resp, e := c.Post("http://agent/v1/admission-leases", "application/json", bytes.NewReader(body))
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	var lease entrypolicy.Lease
	if e = json.NewDecoder(resp.Body).Decode(&lease); e != nil || !lease.Allowed || lease.AccountID != "account" {
		t.Fatalf("lease=%+v err=%v", lease, e)
	}
	for _, tc := range []struct {
		path, body string
		status     int
	}{{"/v1/admission-leases", `{"command":"rm"}`, 400}, {"/v1/shell", `{"command":"echo"}`, 404}, {"/v1/admission-leases", `{} {}`, 400}} {
		res, e := c.Post("http://agent"+tc.path, "application/json", bytes.NewBufferString(tc.body))
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatalf("%s status=%d", tc.path, res.StatusCode)
		}
	}
}
func TestAdmissionBrokerNeverReplacesUnrelatedFile(t *testing.T) {
	root := privateShortRoot(t)
	path := filepath.Join(root, "admission.sock")
	if e := os.WriteFile(path, []byte("retained"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := StartUnixAdmissionBroker(root, brokerAuthority{}); e == nil {
		t.Fatal("unrelated file replaced")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "retained" {
		t.Fatal("existing file changed")
	}
}
