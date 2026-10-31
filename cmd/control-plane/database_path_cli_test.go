//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestDatabasePathCLIChild(t *testing.T) {
	if os.Getenv("RW_PATH_CHILD") != "1" {
		return
	}
	separator := 0
	for i, arg := range os.Args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator == 0 {
		t.Fatal("missing subprocess args")
	}
	os.Args = append([]string{"control-plane"}, os.Args[separator+1:]...)
	flag.CommandLine = flag.NewFlagSet("control-plane", flag.ContinueOnError)
	if e := run(); e == nil || !strings.Contains(e.Error(), "plain filesystem path") {
		t.Fatalf("CLI did not reject ambiguous DB path before startup/recovery: %v", e)
	}
	fmt.Println("ambiguous database path rejected")
}

func TestNormalServerAndOfflineRecoveryRejectSQLiteAliases(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.db")
	release, e := acquireProcessLock(path)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	key := bytes.Repeat([]byte{92}, 32)
	live, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer live.Close()
	if e = live.EnsureAdmin("synthetic-admin", "synthetic-original-password"); e != nil {
		t.Fatal(e)
	}
	for _, alias := range []string{"file:state.db", "state.db?mode=rw"} {
		for _, recovery := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/recovery=%v", alias, recovery), func(t *testing.T) {
				// A literal alias file existed in the original exploit after the lock open;
				// ensure the recovery stat check cannot mask a path-interpretation defect.
				if e = os.WriteFile(filepath.Join(dir, alias), nil, 0600); e != nil {
					t.Fatal(e)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				args := []string{"-test.run=^TestDatabasePathCLIChild$", "--", "-db", alias, "-listen", "127.0.0.1:0"}
				if recovery {
					args = append(args, "-recover-account", "synthetic-admin", "-recover-reason", "Synthetic alias regression")
				}
				cmd := exec.CommandContext(ctx, os.Args[0], args...)
				cmd.Dir = dir
				for _, value := range os.Environ() {
					if !strings.HasPrefix(value, "ROUTEWEAVER_") && !strings.HasPrefix(value, "RW_PATH_CHILD=") {
						cmd.Env = append(cmd.Env, value)
					}
				}
				cmd.Env = append(cmd.Env, "RW_PATH_CHILD=1", fmt.Sprintf("ROUTEWEAVER_MASTER_KEY=%x", key))
				cmd.Stdin = strings.NewReader("synthetic-temporary-password\n")
				output, e := cmd.CombinedOutput()
				if e != nil || !strings.Contains(string(output), "ambiguous database path rejected") {
					t.Fatalf("alias CLI escaped rejection: %v %s", e, output)
				}
				if _, _, _, e = live.Login("synthetic-admin", "synthetic-original-password", "", time.Now()); e != nil {
					t.Fatal("live account changed through alias", e)
				}
			})
		}
	}
}
