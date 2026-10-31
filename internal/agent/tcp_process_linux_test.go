//go:build linux

package agent

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOrdinaryTCPProcessHelper(t *testing.T) {
	mode := ""
	for i, arg := range os.Args {
		if arg == "--tcp-helper" && i+1 < len(os.Args) {
			mode = os.Args[i+1]
		}
	}
	if mode == "" {
		return
	}
	var config net.ListenConfig
	if config.MultipathTCP() || os.Getenv("GODEBUG") != "http2server=0,multipathtcp=0" {
		fmt.Fprint(os.Stderr, "unsupported MPTCP default")
		os.Exit(8)
	}
	switch mode {
	case "version":
		fmt.Print("ordinary-tcp-v1")
		os.Exit(0)
	case "check":
		os.Exit(0)
	case "run":
		listener, err := config.Listen(context.Background(), "tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(9)
		}
		defer listener.Close()
		if err = os.WriteFile("tcp-ready", []byte(listener.Addr().String()), 0600); err != nil {
			os.Exit(10)
		}
		for {
			conn, err := listener.Accept()
			if err != nil {
				os.Exit(11)
			}
			conn.Write([]byte("ordinary TCP"))
			conn.Close()
		}
	}
	os.Exit(12)
}

func TestSupervisedCommandsForceOrdinaryTCPWithoutAmbientSettings(t *testing.T) {
	t.Setenv("GODEBUG", "multipathtcp=1,http2client=0")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := func(mode string) []string {
		return []string{"-test.run=^TestOrdinaryTCPProcessHelper$", "--", "--tcp-helper", mode}
	}
	checker, err := NewCommandChecker(Descriptor{ID: "audit/tcp-helper", Version: "1", NativeValidation: true, Source: "local benign TCP fixture"}, binary, time.Second, NativeCommandSpec{
		Environment: func(Staged) []string {
			return []string{"GODEBUG=http2server=0,multipathtcp=1", "GORACE=atexit_sleep_ms=0"}
		},
		VersionArgs: args("version"), MatchVersion: func(out, _ string) bool { return strings.TrimSpace(out) == "ordinary-tcp-v1" }, ValidateArgs: func(Staged) []string { return args("check") }, RunArgs: func(Staged) []string { return args("run") },
	})
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 20 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	r := openTest(t, t.TempDir(), supervisor)
	d := testDesired(t, 1)
	d.AdapterID = "audit/tcp-helper"
	state, err := r.Submit(context.Background(), d)
	if err != nil || state.Phase != ObservedConformant {
		t.Fatalf("normal supervised TCP rejected: %+v %v", state, err)
	}
	defer supervisor.Stop(context.Background(), r.Root())
	// The observed native child must publish a real endpoint, not just stay alive.
	ready := filepath.Join(r.Root(), "current", "tcp-ready")
	var address []byte
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		address, err = os.ReadFile(ready)
		if err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", string(address), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	data := make([]byte, 32)
	n, err := conn.Read(data)
	if err != nil || string(data[:n]) != "ordinary TCP" {
		t.Fatalf("payload=%q err=%v", data[:n], err)
	}
}
