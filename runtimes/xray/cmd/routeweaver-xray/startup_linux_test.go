//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/xtls/xray-core/transport/internet"

	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

// Exercise the command with real native construction, real listener failures,
// and persistent files. No synthetic runtime observation is supplied.
func TestFailedStartupFinalizesDrainedEpochBeforeAnotherAttempt(t *testing.T) {
	for _, failure := range []string{"native listener", "control listener"} {
		t.Run(failure, func(t *testing.T) {
			// Keep Unix socket paths below the platform limit regardless of the
			// test runner's long test-name temporary directory prefix.
			dir, err := os.MkdirTemp("", "rw-start-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			occupied, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer occupied.Close()
			control := filepath.Join(dir, "control.sock")
			if failure == "control listener" {
				listener, err := net.Listen("unix", control)
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
			}
			native := map[string]any{"log": map[string]any{"loglevel": "none"}, "inbounds": []any{map[string]any{"tag": "public", "listen": "127.0.0.1", "port": occupied.Addr().(*net.TCPAddr).Port, "protocol": "vless", "settings": map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "email": "opaque-subject"}}}, "streamSettings": map[string]any{"network": "tcp", "security": "none"}}}, "outbounds": []any{map[string]any{"tag": "direct", "protocol": "freedom"}}}
			d := entrypolicy.Descriptor{SchemaVersion: 1, AdapterID: managed.AdapterID, RuntimeVersion: managed.Version, CoreVersion: managed.CoreVersion, Bindings: []entrypolicy.Binding{{SubjectID: "opaque-subject", AccountID: "account-1", RouteID: "route-1", EntryID: "entry-1", InboundTag: "public", CredentialVersion: "credential-1", PolicyRevision: "policy-1", CycleID: "cycle-1"}}}
			for name, value := range map[string]any{"native.json": native, "policy.json": d} {
				b, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
					t.Fatal(err)
				}
			}
			journal := filepath.Join(dir, "journal")
			args := []string{"run", "--config", filepath.Join(dir, "native.json"), "--policy", filepath.Join(dir, "policy.json"), "--journal-dir", journal, "--ipc", "unix", "--admission-socket", filepath.Join(dir, "admission.sock"), "--control-socket", control}
			for attempt := 1; attempt <= 2; attempt++ {
				err = run(args)
				if err == nil {
					t.Fatal("occupied listener unexpectedly started")
				}
				if !strings.Contains(err.Error(), "address already in use") {
					t.Fatalf("original listener error lost: %v", err)
				}
				if strings.Contains(err.Error(), "unclean or concurrent") {
					t.Fatalf("clean failed startup blocked next epoch: %v", err)
				}
				if failure == "native listener" && !strings.Contains(err.Error(), "runtime start failed") {
					t.Fatalf("wrong failure: %v", err)
				}
				if _, err = os.Stat(filepath.Join(journal, "running.json")); !os.IsNotExist(err) {
					t.Fatalf("failed startup did not finalize: %v", err)
				}
				finals, err := filepath.Glob(filepath.Join(journal, "*.final.json"))
				if err != nil || len(finals) != attempt {
					t.Fatalf("finals = %v: %v", finals, err)
				}
				for _, final := range finals {
					b, err := os.ReadFile(final)
					if err != nil {
						t.Fatal(err)
					}
					var snapshot entrypolicy.Snapshot
					if err = json.Unmarshal(b, &snapshot); err != nil {
						t.Fatal(err)
					}
					if snapshot.ActiveFlows != 0 || snapshot.CounterEpoch == "" || snapshot.AdapterID != managed.AdapterID || len(snapshot.Counters) != 1 || snapshot.Counters[0].Binding != d.Bindings[0] {
						t.Fatalf("incomplete final: %+v", snapshot)
					}
					if _, err = os.Stat(filepath.Join(journal, snapshot.CounterEpoch+".baseline.json")); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
}

// Xray's public listener controller is global and has no unregister operation.
// Run the real-network fault in a child so no other native test inherits it.
func TestPartialNativeStartupDrainsOpenedListener(t *testing.T) {
	if os.Getenv("RW_PARTIAL_START_CHILD") != "1" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestPartialNativeStartupDrainsOpenedListener$", "-test.timeout=30s")
		cmd.Env = append(os.Environ(), "RW_PARTIAL_START_CHILD=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("partial startup child: %v\n%s", err, output)
		}
		return
	}

	var reservations []net.Listener
	for i := 0; i < 2; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		reservations = append(reservations, l)
		defer l.Close()
	}
	native, d := lifecycleFixture()
	var config map[string]any
	if err := json.Unmarshal(native, &config); err != nil {
		t.Fatal(err)
	}
	first := config["inbounds"].([]any)[0].(map[string]any)
	first["port"] = reservations[0].Addr().(*net.TCPAddr).Port
	second := make(map[string]any)
	for key, value := range first {
		second[key] = value
	}
	second["tag"] = "public-b"
	second["port"] = reservations[1].Addr().(*net.TCPAddr).Port
	config["inbounds"] = []any{first, second}
	binding := d.Bindings[0]
	binding.InboundTag = "public-b"
	binding.EntryID = "entry-2"
	d.Bindings = append(d.Bindings, binding)
	native, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	r, err := managed.New(native, d, unavailableAdmission{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	dir := filepath.Join(t.TempDir(), "journal")
	baseline := r.Snapshot()
	journal, err := managed.BeginJournal(dir, baseline)
	if err != nil {
		t.Fatal(err)
	}

	var openedAddress string
	var blocker net.Listener
	var boundaryErr error
	observedOpen := false
	// The tagged-inbound map has no defined order. Select whichever listener
	// actually starts first. Before the next real bind, observe the first over
	// TCP, then occupy the second port with a real independent listener.
	err = internet.RegisterListenerController(func(network, address string, _ syscall.RawConn) error {
		if openedAddress == "" {
			openedAddress = address
			return nil
		}
		if blocker != nil || boundaryErr != nil {
			return nil
		}
		c, err := net.DialTimeout("tcp", openedAddress, time.Second)
		if err != nil {
			boundaryErr = fmt.Errorf("first native listener not open: %w", err)
			return nil
		}
		observedOpen = true
		c.Close()
		blocker, boundaryErr = net.Listen("tcp", address)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range reservations {
		if err = l.Close(); err != nil {
			t.Fatal(err)
		}
	}
	startupErr := r.Start()
	if blocker != nil {
		defer blocker.Close()
	}
	if boundaryErr != nil || !observedOpen || blocker == nil {
		t.Fatalf("partial startup boundary not reached: open=%v, blocker=%v, error=%v", observedOpen, blocker, boundaryErr)
	}
	if startupErr == nil || !strings.Contains(startupErr.Error(), "address already in use") {
		t.Fatalf("expected real second listener collision: %v", startupErr)
	}
	// The first native listener must still be open after Start failed, proving
	// this is partial startup rather than an error before any listener opens.
	c, err := net.DialTimeout("tcp", openedAddress, time.Second)
	if err != nil {
		t.Fatalf("first listener was not retained after partial startup: %v", err)
	}
	c.Close()
	result := finishRuntime(r, journal, startupErr)
	if !errors.Is(result, startupErr) {
		t.Fatalf("cleanup did not preserve original startup failure: %v", result)
	}
	c, err = net.DialTimeout("tcp", openedAddress, time.Second)
	if err == nil {
		c.Close()
		t.Fatal("partially started native listener survived drain")
	}
	if _, err = os.Stat(filepath.Join(dir, "running.json")); !os.IsNotExist(err) {
		t.Fatalf("drained epoch retained running marker: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, baseline.CounterEpoch+".final.json"))
	if err != nil {
		t.Fatal(err)
	}
	var final entrypolicy.Snapshot
	if err = json.Unmarshal(b, &final); err != nil {
		t.Fatal(err)
	}
	if final.ActiveFlows != 0 || final.CounterEpoch != baseline.CounterEpoch || len(final.Counters) != 2 {
		t.Fatalf("incomplete partial-start final snapshot: %+v", final)
	}
	for i, counter := range final.Counters {
		if counter.Binding != baseline.Counters[i].Binding || counter.CounterEpoch != baseline.Counters[i].CounterEpoch {
			t.Fatalf("partial-start final lost binding evidence: %+v", final)
		}
	}
}
