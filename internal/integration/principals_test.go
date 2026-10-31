//go:build linux

package integration_test

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/render"
)

// Two VLESS credentials share one listening socket but preserve independent
// authenticated routes. Stopping the required downstream hop must break only
// its principal, not silently fall back to the other principal's direct path.
func TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate(t *testing.T) {
	testSharedVLESSIngress(t, false)
}
func TestManagedSharedVLESSIngressKeepsPrincipalPathsSeparate(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN") == "" {
		t.Skip("explicit managed runtime binary required")
	}
	testSharedVLESSIngress(t, true)
}
func testSharedVLESSIngress(t *testing.T, managed bool) {
	dir := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if dir == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("requires explicit local Xray process opt-in")
	}
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); conn.SetDeadline(time.Now().Add(5 * time.Second)); io.Copy(conn, conn) }()
		}
	}()
	freePort := func() int {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		return listener.Addr().(*net.TCPAddr).Port
	}
	entryPort, exitPort := freePort(), freePort()
	transit := domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: exitPort, Username: "synthetic-transit", Password: "not-a-public-user-credential"}
	uuidA, uuidB := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	ingress := domain.ServerProgram{Instance: domain.CoreInstance{ID: "shared", HostID: "fixture", AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, Listener: domain.ManagedEndpoint{ID: "public-entry", InstanceID: "shared", Name: "Shared public ingress", Authentication: "principals", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: entryPort}}, Connectors: []domain.ServerConnector{{ID: "via-exit", Connection: transit}}, DefaultAction: domain.ActionRef{Kind: "reject"}, Principals: []domain.ServerPrincipal{
		{SubjectID: "opaque-alice", AccountID: "alice", RouteID: "direct-path", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: uuidA}, Action: domain.ActionRef{Kind: "direct"}},
		{SubjectID: "opaque-bob", AccountID: "bob", RouteID: "transit-path", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: uuidB}, Action: domain.ActionRef{Kind: "forward", Ref: "via-exit"}},
	}}
	if managed {
		ingress.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
		ingress.Instance.AdapterID = render.ServerAdapterManagedXray
		ingress.Instance.Version = render.ManagedXrayVersion
		for i := range ingress.Principals {
			ingress.Principals[i].PolicyRevision = "policy1"
			ingress.Principals[i].CycleID = "cycle1"
		}
	}
	exit := domain.ServerProgram{Instance: domain.CoreInstance{ID: "exit", HostID: "fixture", AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}, Listener: domain.ManagedEndpoint{ID: "transit-entry", InstanceID: "exit", Name: "Private transit", Connection: transit}}
	artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "shared-ingress-proof", TopologyRevision: "r1", Programs: []domain.ServerProgram{exit, ingress}})
	if err != nil {
		t.Fatal(err)
	}
	supervisors := map[string]*agent.ProcessSupervisor{}
	roots := map[string]string{}
	for _, instance := range []string{"exit", "shared"} {
		adapter, version, binary := render.ServerAdapterXray, render.XrayVersion, filepath.Join(dir, "xray")
		if managed && instance == "shared" {
			adapter, version, binary = render.ServerAdapterManagedXray, render.ManagedXrayVersion, os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
		}
		root, err := os.MkdirTemp("", "rw-principal-")
		if err != nil {
			t.Fatal(err)
		}
		retain := false
		t.Cleanup(func() {
			if !retain {
				os.RemoveAll(root)
			}
		})
		content, err := os.ReadFile(binary)
		if err != nil {
			t.Fatal(err)
		}
		binary = filepath.Join(root, "native-core")
		if err = os.WriteFile(binary, content, 0700); err != nil {
			t.Fatal(err)
		}
		checker, err := agent.NewNativeChecker(adapter, version, binary, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
		if err != nil {
			t.Fatal(err)
		}
		scope := agent.Scope{NodeID: "fixture", InstanceID: instance, EnrollmentEpoch: "epoch1"}
		reconciler, err := agent.Open(root, scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
		if err != nil {
			t.Fatal(err)
		}
		if managed && instance == "shared" {
			broker, err := agent.StartAdmissionBroker(root, pathAdmission{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { broker.Close() })
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := supervisor.Stop(ctx, root); err != nil {
				retain = true
				t.Errorf("native cleanup refused; retained exact identity evidence at %s: %v", root, err)
			}
			reconciler.Close()
		})
		material := []domain.Artifact{}
		for _, artifact := range artifacts {
			if strings.HasPrefix(artifact.Path, instance+"/") {
				material = append(material, domain.Artifact{Path: strings.TrimPrefix(artifact.Path, instance+"/"), Content: artifact.Content})
			}
		}
		digest, _ := agent.ArtifactDigest(material)
		now := time.Now()
		desired := agent.Desired{Scope: scope, AdapterID: adapter, CoreVersion: version, Generation: 1, RevisionID: "r1", OperationID: "op1", Digest: digest, EntryFile: "config.json", Artifacts: material, Lease: agent.PolicyLease{Revision: "p1", IssuedAt: now, ExpiresAt: now.Add(time.Minute), AccessAllowed: true, QuotaCertain: true}}
		state, err := reconciler.Submit(context.Background(), desired)
		if err != nil || state.Phase != agent.ObservedConformant {
			t.Fatalf("generated native shared ingress apply: %s %v", state.Phase, err)
		}
		supervisors[instance] = supervisor
		roots[instance] = root
	}
	open := func(uuid string) (net.Conn, error) {
		return dialPrincipalProof(fmt.Sprintf("127.0.0.1:%d", entryPort), echo.Addr().(*net.TCPAddr).Port, uuid)
	}
	roundtrip := func(uuid string) error {
		conn, err := open(uuid)
		if err != nil {
			return err
		}
		return conn.Close()
	}
	if err = roundtrip(uuidA); err != nil {
		t.Fatalf("first authenticated user: %v", err)
	}
	if err = roundtrip(uuidB); err != nil {
		t.Fatalf("second authenticated user: %v", err)
	}
	if err = roundtrip("00000000-0000-4000-8000-000000000003"); err == nil {
		t.Fatal("unregistered principal passed authentication")
	}
	if managed {
		alice, err := open(uuidA)
		if err != nil {
			t.Fatal(err)
		}
		defer alice.Close()
		bob, err := open(uuidB)
		if err != nil {
			t.Fatal(err)
		}
		defer bob.Close()
		if err = agent.RevokeManagedAccount(context.Background(), roots["shared"], "alice"); err != nil {
			t.Fatal(err)
		}
		exchange := func(conn net.Conn) error {
			conn.SetDeadline(time.Now().Add(time.Second))
			if _, err := conn.Write([]byte("still")); err != nil {
				return err
			}
			reply := make([]byte, 5)
			_, err := io.ReadFull(conn, reply)
			return err
		}
		if err = exchange(alice); err == nil {
			t.Fatal("revoked account retained existing connection")
		}
		if err = roundtrip(uuidA); err == nil {
			t.Fatal("revoked account opened new connection")
		}
		if err = exchange(bob); err != nil {
			t.Fatalf("revoking Alice interrupted Bob's existing connection: %v", err)
		}
		if err = roundtrip(uuidB); err != nil {
			t.Fatalf("revoking Alice denied Bob's new connection: %v", err)
		}
	}
	if err = supervisors["exit"].Stop(context.Background(), roots["exit"]); err != nil {
		t.Fatal(err)
	}
	if !managed {
		if err = roundtrip(uuidA); err != nil {
			t.Fatalf("one path failure stopped another account's direct path: %v", err)
		}
	}
	if err = roundtrip(uuidB); err == nil {
		t.Fatal("transit principal bypassed its failed required hop")
	}
}

// This authority isolates the native routing seam. Full HTTP admission and
// quota correctness are tested independently through the control-plane API.
type pathAdmission struct{}

func (pathAdmission) Acquire(_ context.Context, r entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	account, route := "", ""
	switch r.SubjectID {
	case "opaque-alice":
		account, route = "alice", "direct-path"
	case "opaque-bob":
		account, route = "bob", "transit-path"
	default:
		return entrypolicy.Lease{Allowed: false, Reason: "unknown-subject"}, nil
	}
	if r.ClientIP != "127.0.0.1" || r.EntryID != "public-entry" || r.CredentialVersion != "v1" {
		return entrypolicy.Lease{Allowed: false, Reason: "wrong-binding"}, nil
	}
	return entrypolicy.Lease{Allowed: true, LeaseID: r.PresenceID, AccountID: account, RouteID: route, ExpiresAt: time.Now().Add(entrypolicy.MaxLease)}, nil
}
func (pathAdmission) Release(context.Context, string) error { return nil }

func dialPrincipalProof(address string, port int, uuid string) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	id, err := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	if err != nil {
		return nil, err
	}
	header := append([]byte{0}, id...)
	header = append(header, 0, 1, byte(port>>8), byte(port), 1, 127, 0, 0, 1)
	payload := []byte("principal-path-proof")
	header = append(header, payload...)
	if _, err = conn.Write(header); err != nil {
		return nil, err
	}
	response := make([]byte, 2)
	if _, err = io.ReadFull(conn, response); err != nil {
		return nil, err
	}
	if response[0] != 0 || response[1] != 0 {
		return nil, fmt.Errorf("invalid VLESS response")
	}
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(conn, got); err != nil {
		return nil, err
	}
	if string(got) != string(payload) {
		return nil, fmt.Errorf("payload mismatch")
	}
	ok = true
	return conn, nil
}
