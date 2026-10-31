//go:build linux

package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNativeSupervisorLifecycleAndRestart(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" {
		t.Skip("explicit native binaries required")
	}
	for _, tc := range []struct{ id, version, binary, config string }{{"routeweaver/xray", "26.10.29", "xray", `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`}, {"routeweaver/sing-box", "1.14.4", "sing-box", `{"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`}} {
		t.Run(tc.binary, func(t *testing.T) {
			if !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ","+tc.binary+",") {
				t.Skip("native process family not explicitly enabled")
			}
			checker, err := NewNativeChecker(tc.id, tc.version, filepath.Join(dir, tc.binary+"-"+tc.version+"-linux-amd64"), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			a, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 100 * time.Millisecond, StopTimeout: 2 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			r := openTest(t, root, a)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := a.Stop(ctx, root); err != nil {
					t.Error(err)
				}
			})
			d := nativeDesired(t, tc.id, tc.version)
			d.Artifacts[0].Content = tc.config
			d.Digest, _ = ArtifactDigest(d.Artifacts)
			st, err := r.Submit(context.Background(), d)
			if err != nil || st.Observed == nil || st.Observed.Evidence != "owned_process_liveness" || !st.NativeChecked {
				t.Fatalf("first process: %+v %v", st, err)
			}
			r.Close()
			r = openTest(t, root, a)
			if st, err = r.Recover(context.Background()); err != nil || st.Phase != ObservedConformant {
				t.Fatalf("restart: %+v %v", st, err)
			}
			d.Generation = 2
			d.OperationID = "operation-b"
			if st, err = r.Submit(context.Background(), d); err != nil || st.Observed.Generation != 2 {
				t.Fatalf("replacement: %+v %v", st, err)
			}
			if err = a.Stop(context.Background(), root); err != nil {
				t.Fatal(err)
			}
			if st, err = r.Recover(context.Background()); err != nil || st.Phase == ObservedConformant || st.Observed != nil {
				t.Fatal("terminated process cannot remain observed conformant")
			}
		})
	}
}

// Recovery observes a dead leader before os/exec's reaper has collected it. The
// zombie itself must not be misclassified as an unobserved live descendant.
func TestSupervisorWaitsForOwnedZombieReapingWithoutWeakeningGroupSafety(t *testing.T) {
	for _, descendant := range []bool{false, true} {
		t.Run(fmt.Sprintf("live-descendant=%t", descendant), func(t *testing.T) {
			binary, err := exec.LookPath("sleep")
			if err != nil {
				t.Fatal(err)
			}
			leader := exec.Command(binary, "0.05")
			leader.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err = leader.Start(); err != nil {
				t.Fatal(err)
			}
			start, executable, alive, err := processIdentity(leader.Process.Pid)
			if err != nil || !alive {
				t.Fatalf("leader identity: %v %v", alive, err)
			}
			boot, err := bootID()
			if err != nil {
				t.Fatal(err)
			}
			if descendant {
				child := exec.Command(binary, "10")
				child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: leader.Process.Pid}
				if err = child.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { child.Process.Kill(); child.Wait() })
			}
			root := t.TempDir()
			if err = writeJSON(processFile(root), processRecord{PID: leader.Process.Pid, StartTicks: start, Executable: executable, BootID: boot}); err != nil {
				t.Fatal(err)
			}
			checker, err := NewNativeChecker("routeweaver/xray", "26.3.27", binary, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: time.Millisecond, StopTimeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(time.Second)
			for {
				_, _, alive, err = processIdentity(leader.Process.Pid)
				if err != nil {
					t.Fatal(err)
				}
				if !alive {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("fixture leader did not exit")
				}
				time.Sleep(time.Millisecond)
			}
			reaped := make(chan struct{})
			go func() { time.Sleep(25 * time.Millisecond); leader.Wait(); close(reaped) }()
			err = supervisor.Stop(context.Background(), root)
			<-reaped
			if descendant && err == nil {
				t.Fatal("live unowned group member incorrectly considered stopped")
			}
			if !descendant && err != nil {
				t.Fatal("owned zombie misclassified as live descendant:", err)
			}
		})
	}
}
