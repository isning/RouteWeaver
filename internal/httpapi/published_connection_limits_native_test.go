package httpapi_test

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"routeweaver/internal/service"
	"strings"
	"sync"
	"testing"
	"time"
)

// This proof uses the real authenticated CP, managed runtime and transit from
// the published-principal fixture. TCP connections and mux logical streams
// compete for the same account cap, independent of their shared localhost IP.
func provePublishedConnectionLimits(t *testing.T, post func(string, any) map[string]any, base string, admin *http.Client, user sessionClient, plan service.Plan, entryPort int, uuid string) {
	t.Helper()
	awaitPublishedBudgetsClosed(t, admin, base, "managed-core")
	original := plan
	plan.QuotaBytes = 16 << 20
	plan.OnlineIPLimit = 1
	plan.ConnectionLimit = 2
	post("services", plan)
	target, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	stop := make(chan struct{})
	var stopOnce sync.Once
	stopTargets := func() { stopOnce.Do(func() { close(stop) }) }
	defer stopTargets()
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() {
				select {
				case <-stop:
					c.Close()
				}
			}()
			go func() { defer c.Close(); c.SetDeadline(time.Now().Add(30 * time.Second)); io.Copy(c, c) }()
		}
	}()
	targetPort := target.Addr().(*net.TCPAddr).Port
	first, e := openPublishedStream(entryPort, targetPort, uuid, "tcp-first")
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	mux, e := dialPublishedEntry(entryPort, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer mux.Close()
	credential, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	header := append([]byte{0}, credential...)
	header = append(header, 0, 3)
	if _, e = mux.Write(header); e != nil {
		t.Fatal(e)
	}
	if e = writePublishedMux(mux, 1, 1, targetPort, []byte("mux-one")); e != nil {
		t.Fatal(e)
	}
	response := make([]byte, 2)
	mux.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, e = io.ReadFull(mux, response); e != nil {
		t.Fatal(e)
	}
	if e = readPublishedMux(mux, 1, "mux-one"); e != nil {
		t.Fatalf("second logical stream rejected: %v", e)
	}
	status := awaitPublishedStreams(t, admin, base, user.id, 2)
	if len(status["onlineIps"].([]any)) != 1 {
		t.Fatalf("same IP was not unioned: %v", status)
	}
	if third, e := openPublishedStream(entryPort, targetPort, uuid, "must-not-pass"); e == nil {
		third.Close()
		t.Fatal("third same-IP TCP stream bypassed global connection cap")
	}
	if e = writePublishedMux(mux, 2, 1, targetPort, []byte("must-not-pass")); e != nil {
		t.Fatal(e)
	}
	if e = readPublishedMux(mux, 2, "must-not-pass"); e == nil {
		t.Fatal("second mux stream bypassed global logical-stream cap")
	}
	initialExpiry := status["entries"].([]any)[0].(map[string]any)["latestExpiry"].(string)
	deadline := time.Now().Add(15 * time.Second)
	for {
		status = awaitPublishedStreams(t, admin, base, user.id, 2)
		if status["entries"].([]any)[0].(map[string]any)["latestExpiry"] != initialExpiry {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("at-cap native stream leases did not renew")
		}
		time.Sleep(50 * time.Millisecond)
	}
	first.SetDeadline(time.Now().Add(2 * time.Second))
	if _, e = first.Write([]byte("renewed")); e != nil {
		t.Fatal(e)
	}
	payload := make([]byte, 7)
	if _, e = io.ReadFull(first, payload); e != nil || string(payload) != "renewed" {
		t.Fatalf("existing stream stopped at cap: %q %v", payload, e)
	}
	if e = writePublishedMux(mux, 1, 3, targetPort, nil); e != nil {
		t.Fatal(e)
	}
	awaitPublishedStreams(t, admin, base, user.id, 1)
	if e = writePublishedMux(mux, 3, 1, targetPort, []byte("after-release")); e != nil {
		t.Fatal(e)
	}
	if e = readPublishedMux(mux, 3, "after-release"); e != nil {
		t.Fatalf("released logical slot unavailable: %v", e)
	}
	awaitPublishedStreams(t, admin, base, user.id, 2)
	writePublishedMux(mux, 3, 3, targetPort, nil)
	mux.Close()
	first.Close()
	// End the remote TCP direction too; a legitimate half-closed stream may
	// retain its downlink and therefore its admission until both halves finish.
	target.Close()
	// Close accepted target sockets without waiting for their idle timeout.
	// A separate signal avoids confusing one-way TCP EOF with logical closure.
	stopTargets()
	awaitPublishedStreams(t, admin, base, user.id, 0)
	awaitPublishedBudgetsClosed(t, admin, base, "managed-core")
	post("services", original)
	t.Log("real CP/native: one IP, two independent TCP/mux streams; extra TCP and mux streams denied; existing streams renewed at cap; final close released slots")
}
func awaitPublishedStreams(t *testing.T, admin *http.Client, base, user string, want int) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, out, raw := req(t, admin, "GET", base+"/api/users/"+user+"/admission-status", "", nil)
		if code != 200 {
			t.Fatalf("admission status %d %s", code, raw)
		}
		if out["activeStreams"] == float64(want) {
			return out
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("want %d streams: %s", want, raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
func openPublishedStream(entry, target int, uuid, payload string) (net.Conn, error) {
	c, e := dialPublishedEntry(entry, nil)
	if e != nil {
		return nil, e
	}
	c.SetDeadline(time.Now().Add(2 * time.Second))
	credential, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	header := append([]byte{0}, credential...)
	header = append(header, 0, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
	header = append(header, []byte(payload)...)
	if _, e = c.Write(header); e != nil {
		c.Close()
		return nil, e
	}
	response := make([]byte, len(payload)+2)
	if _, e = io.ReadFull(c, response); e != nil {
		c.Close()
		return nil, e
	}
	if string(response[2:]) != payload {
		c.Close()
		return nil, fmt.Errorf("unexpected native echo")
	}
	c.SetDeadline(time.Time{})
	return c, nil
}

// Encodes the pinned Xray mux FrameMetadata wire contract without importing an
// engine SDK into the control-plane module. A new stream includes TCP target;
// Keep and End frames contain only the four-byte session metadata.
func writePublishedMux(c net.Conn, id uint16, status byte, target int, payload []byte) error {
	option := byte(1)
	if status == 3 {
		option = 0
	}
	meta := []byte{byte(id >> 8), byte(id), status, option}
	if status == 1 {
		meta = append(meta, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
	}
	frame := []byte{byte(len(meta) >> 8), byte(len(meta))}
	frame = append(frame, meta...)
	if option == 1 {
		frame = append(frame, byte(len(payload)>>8), byte(len(payload)))
		frame = append(frame, payload...)
	}
	_, e := c.Write(frame)
	return e
}
func readPublishedMux(c net.Conn, id uint16, want string) error {
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := []byte{}
	for len(got) < len(want) {
		var n uint16
		if e := binary.Read(c, binary.BigEndian, &n); e != nil {
			return e
		}
		if n < 4 || n > 512 {
			return fmt.Errorf("invalid mux metadata")
		}
		meta := make([]byte, n)
		if _, e := io.ReadFull(c, meta); e != nil {
			return e
		}
		stream := binary.BigEndian.Uint16(meta[:2])
		if meta[3]&1 != 0 {
			if e := binary.Read(c, binary.BigEndian, &n); e != nil {
				return e
			}
			payload := make([]byte, n)
			if _, e := io.ReadFull(c, payload); e != nil {
				return e
			}
			if stream == id {
				got = append(got, payload...)
			}
		}
		if stream == id && meta[2] == 3 {
			return fmt.Errorf("mux stream ended")
		}
	}
	if string(got) != want {
		return fmt.Errorf("unexpected mux echo")
	}
	return nil
}
