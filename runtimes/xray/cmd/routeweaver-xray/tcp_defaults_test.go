package main

import (
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestManagedTCPDefaultsChild(t *testing.T) {
	if os.Getenv("RW_MANAGED_TCP_CHILD") != "1" {
		return
	}
	if err := run([]string{"version"}); err != nil {
		t.Fatal(err)
	}
	var config net.ListenConfig
	if config.MultipathTCP() {
		t.Fatal("managed process still requests default MPTCP")
	}
	if !strings.Contains(os.Getenv("GODEBUG"), "http2client=0") {
		t.Fatal("unrelated Go setting lost")
	}
}

func TestManagedCommandDisablesInheritedMPTCPBeforeDispatch(t *testing.T) {
	for _, debug := range []string{"http2client=0", "http2client=0,multipathtcp=1", "multipathtcp=0,http2client=0,multipathtcp=1"} {
		t.Run(debug, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestManagedTCPDefaultsChild$")
			for _, value := range os.Environ() {
				if !strings.HasPrefix(value, "GODEBUG=") && !strings.HasPrefix(value, "RW_MANAGED_TCP_CHILD=") {
					cmd.Env = append(cmd.Env, value)
				}
			}
			cmd.Env = append(cmd.Env, "GODEBUG="+debug, "RW_MANAGED_TCP_CHILD=1")
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("managed defaults: %v\n%s", err, output)
			}
		})
	}
}
