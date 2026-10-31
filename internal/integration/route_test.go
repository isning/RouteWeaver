//go:build linux

package integration_test

import (
	"context"
	"encoding/binary"
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
	"routeweaver/internal/render"
)

// This crosses the real server IR → renderer → native check → owned process
// → loopback traffic seams. No production node, secret or external destination.
func TestRenderedTwoHopRouteHasNoDirectFallback(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
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
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); c.SetDeadline(time.Now().Add(5 * time.Second)); io.Copy(c, c) }()
		}
	}()
	freePort := func() int {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		defer l.Close()
		return l.Addr().(*net.TCPAddr).Port
	}
	aPort, bPort := freePort(), freePort()
	connection := func(port int) domain.Connection {
		return domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: port, Username: "fixture", Password: "local-only"}
	}
	program := func(id string, port int, egress []domain.Connection) domain.ServerProgram {
		return domain.ServerProgram{Instance: domain.CoreInstance{ID: id, HostID: "local-host", AdapterID: "routeweaver/xray", Version: "26.10.31"}, Listener: domain.ManagedEndpoint{ID: id + "-entry", InstanceID: id, Name: id, Connection: connection(port)}, Egress: egress}
	}
	ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "local-route", TopologyRevision: "1", Programs: []domain.ServerProgram{program("b", bPort, nil), program("a", aPort, []domain.Connection{connection(bPort)})}}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	supervisors := map[string]*agent.ProcessSupervisor{}
	roots := map[string]string{}
	for _, artifact := range artifacts {
		instance := strings.Split(artifact.Path, "/")[0]
		checker, e := agent.NewNativeChecker("routeweaver/xray", "26.10.31", filepath.Join(dir, "xray-26.10.31-linux-amd64"), 5*time.Second)
		if e != nil {
			t.Fatal(e)
		}
		supervisor, e := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
		if e != nil {
			t.Fatal(e)
		}
		root := filepath.Join(t.TempDir(), "private-agent")
		scope := agent.Scope{NodeID: "local-host", InstanceID: instance, EnrollmentEpoch: "fixture-epoch"}
		reconciler, e := agent.Open(root, scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if e := supervisor.Stop(ctx, root); e != nil {
				t.Error(e)
			}
			reconciler.Close()
		})
		now := time.Now()
		material := []domain.Artifact{{Path: "config.json", Content: artifact.Content}}
		digest, _ := agent.ArtifactDigest(material)
		desired := agent.Desired{Scope: scope, AdapterID: "routeweaver/xray", CoreVersion: "26.10.31", Generation: 1, RevisionID: "revision-one", OperationID: "apply-one", Digest: digest, EntryFile: "config.json", Artifacts: material, Lease: agent.PolicyLease{Revision: "policy-one", IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(10 * time.Minute), AccessAllowed: true, QuotaCertain: true}}
		state, e := reconciler.Submit(context.Background(), desired)
		if e != nil || state.Phase != agent.ObservedConformant {
			t.Fatalf("generated deployment failed: %s %v", state.Phase, e)
		}
		supervisors[instance] = supervisor
		roots[instance] = root
	}
	roundtrip := func() error {
		c, e := socksConnect(fmt.Sprintf("127.0.0.1:%d", aPort), echo.Addr().(*net.TCPAddr).Port)
		if e != nil {
			return e
		}
		defer c.Close()
		payload := "rendered-route-proof"
		if _, e = io.WriteString(c, payload); e != nil {
			return e
		}
		got := make([]byte, len(payload))
		if _, e = io.ReadFull(c, got); e != nil {
			return e
		}
		if string(got) != payload {
			return fmt.Errorf("payload mismatch")
		}
		return nil
	}
	if err = roundtrip(); err != nil {
		t.Fatalf("IR-generated chain did not carry traffic: %v", err)
	}
	if err = supervisors["b"].Stop(context.Background(), roots["b"]); err != nil {
		t.Fatal(err)
	}
	if err = roundtrip(); err == nil {
		t.Fatal("egress stopped but traffic bypassed the intended hop")
	}
}
func socksConnect(address string, port int) (net.Conn, error) {
	return socksConnectDestination(address, "127.0.0.1", port)
}
func socksConnectDestination(address, host string, port int) (net.Conn, error) {
	c, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err = c.Write([]byte{5, 1, 2}); err != nil {
		return nil, err
	}
	reply := make([]byte, 2)
	if _, err = io.ReadFull(c, reply); err != nil {
		return nil, err
	}
	if reply[0] != 5 || reply[1] != 2 {
		return nil, fmt.Errorf("SOCKS auth negotiation")
	}
	user, password := "fixture", "local-only"
	auth := append([]byte{1, byte(len(user))}, []byte(user)...)
	auth = append(auth, byte(len(password)))
	auth = append(auth, []byte(password)...)
	if _, err = c.Write(auth); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(c, reply); err != nil {
		return nil, err
	}
	if reply[1] != 0 {
		return nil, fmt.Errorf("SOCKS auth rejected")
	}
	var request []byte
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append([]byte{5, 1, 0, 1}, ip.To4()...)
	} else {
		if len(host) == 0 || len(host) > 255 {
			return nil, fmt.Errorf("invalid fixture destination")
		}
		request = append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	}
	request = append(request, 0, 0)
	binary.BigEndian.PutUint16(request[len(request)-2:], uint16(port))
	if _, err = c.Write(request); err != nil {
		return nil, err
	}
	head := make([]byte, 4)
	if _, err = io.ReadFull(c, head); err != nil {
		return nil, err
	}
	if head[1] != 0 {
		return nil, fmt.Errorf("SOCKS connect rejected")
	}
	size := 0
	switch head[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		b := make([]byte, 1)
		if _, err = io.ReadFull(c, b); err != nil {
			return nil, err
		}
		size = int(b[0])
	default:
		return nil, fmt.Errorf("SOCKS address type")
	}
	if _, err = io.CopyN(io.Discard, c, int64(size+2)); err != nil {
		return nil, err
	}
	ok = true
	return c, nil
}
