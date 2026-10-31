//go:build linux

package agent

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
)

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}
func socksFixtureConnect(address string, port int) (net.Conn, error) {
	c, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			c.Close()
		}
	}()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err = c.Write([]byte{5, 1, 2}); err != nil {
		return nil, err
	}
	reply := make([]byte, 2)
	if _, err = io.ReadFull(c, reply); err != nil {
		return nil, err
	}
	if reply[0] != 5 || reply[1] != 2 {
		return nil, fmt.Errorf("SOCKS auth selection rejected")
	}
	user, pass := "fixture", "local-only"
	auth := append([]byte{1, byte(len(user))}, []byte(user)...)
	auth = append(auth, byte(len(pass)))
	auth = append(auth, []byte(pass)...)
	if _, err = c.Write(auth); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(c, reply); err != nil {
		return nil, err
	}
	if reply[1] != 0 {
		return nil, fmt.Errorf("SOCKS fixture auth rejected")
	}
	req := []byte{5, 1, 0, 1, 127, 0, 0, 1, 0, 0}
	binary.BigEndian.PutUint16(req[8:], uint16(port))
	if _, err = c.Write(req); err != nil {
		return nil, err
	}
	header := make([]byte, 4)
	if _, err = io.ReadFull(c, header); err != nil {
		return nil, err
	}
	if header[1] != 0 {
		return nil, fmt.Errorf("SOCKS connect rejected: %d", header[1])
	}
	var n int
	switch header[3] {
	case 1:
		n = 4
	case 4:
		n = 16
	case 3:
		b := make([]byte, 1)
		if _, err = io.ReadFull(c, b); err != nil {
			return nil, err
		}
		n = int(b[0])
	default:
		return nil, fmt.Errorf("invalid SOCKS address")
	}
	if _, err = io.CopyN(io.Discard, c, int64(n+2)); err != nil {
		return nil, err
	}
	success = true
	return c, nil
}

func TestNativeXrayTwoHopLoopbackRoundtrip(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit Xray process opt-in required")
	}
	destination, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	destinationPort := destination.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, e := destination.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); c.SetDeadline(time.Now().Add(5 * time.Second)); _, _ = io.Copy(c, c) }()
		}
	}()
	portA, portB := freeLoopbackPort(t), freeLoopbackPort(t)
	inbound := func(port int) string {
		return fmt.Sprintf(`{"listen":"127.0.0.1","port":%d,"protocol":"socks","settings":{"auth":"password","accounts":[{"user":"fixture","pass":"local-only"}],"udp":false}}`, port)
	}
	configB := `{"log":{"loglevel":"none"},"inbounds":[` + inbound(portB) + `],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	configA := fmt.Sprintf(`{"log":{"loglevel":"none"},"inbounds":[%s],"outbounds":[{"protocol":"socks","tag":"through-b","settings":{"servers":[{"address":"127.0.0.1","port":%d,"users":[{"user":"fixture","pass":"local-only"}]}]}}]}`, inbound(portA), portB)
	activate := func(instance, config string) (*Reconciler, *ProcessSupervisor) {
		checker, e := NewNativeChecker("routeweaver/xray", "26.10.29", filepath.Join(dir, "xray-26.10.29-linux-amd64"), 5*time.Second)
		if e != nil {
			t.Fatal(e)
		}
		supervisor, e := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 100 * time.Millisecond, StopTimeout: time.Second})
		if e != nil {
			t.Fatal(e)
		}
		d := nativeDesired(t, "routeweaver/xray", "26.10.29")
		d.InstanceID = instance
		d.Artifacts[0].Content = config
		d.Digest, _ = ArtifactDigest(d.Artifacts)
		root := filepath.Join(t.TempDir(), "private-state")
		r, e := Open(root, d.Scope, NewRegistry(supervisor), Options{MaxLease: 2 * time.Hour})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if e := supervisor.Stop(ctx, root); e != nil {
				t.Error(e)
			}
			r.Close()
		})
		if st, e := r.Submit(context.Background(), d); e != nil || st.Phase != ObservedConformant {
			t.Fatalf("start %s: %+v %v", instance, st, e)
		}
		return r, supervisor
	}
	b, supervisorB := activate("hop-b", configB)
	activate("hop-a", configA)
	client, err := socksFixtureConnect(fmt.Sprintf("127.0.0.1:%d", portA), destinationPort)
	if err != nil {
		t.Fatal(err)
	}
	payload := "routeweaver-two-hop-fixture"
	if _, err = io.WriteString(client, payload); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, len(payload))
	if _, err = io.ReadFull(client, reply); err != nil {
		t.Fatal(err)
	}
	client.Close()
	if string(reply) != payload {
		t.Fatal("roundtrip payload changed")
	}
	// Stop the middle hop and prove a fresh connection cannot silently bypass it.
	if err = supervisorB.Stop(context.Background(), b.Root()); err != nil {
		t.Fatal(err)
	}
	client, err = socksFixtureConnect(fmt.Sprintf("127.0.0.1:%d", portA), destinationPort)
	if err == nil {
		defer client.Close()
		_, err = io.WriteString(client, payload)
		if err == nil {
			_, err = io.ReadFull(client, reply)
		}
	}
	if err == nil {
		t.Fatal("traffic bypassed the stopped middle hop")
	}
}
