//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestSupervisorProcessLookupAbsencePreservesUnknownErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		absent bool
	}{
		{"missing", syscall.ENOENT, true},
		{"reaped", syscall.ESRCH, true},
		{"permission", syscall.EPERM, false},
		{"access", syscall.EACCES, false},
		{"io", syscall.EIO, false},
		{"interrupted", syscall.EINTR, false},
		{"malformed", errors.New("invalid process stat"), false},
		{"nil", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			variants := []error{tc.err}
			if tc.err != nil {
				variants = append(variants, &os.PathError{Op: "read", Path: "/proc/fixture/stat", Err: tc.err}, fmt.Errorf("lookup: %w", tc.err))
			}
			for _, err := range variants {
				if got := processLookupAbsent(err); got != tc.absent {
					t.Fatalf("absence=%t, want %t for error_type=%T", got, tc.absent, err)
				}
			}
		})
	}
}

// Reproduce the kernel exit-read mechanism, not the historical CI interleaving:
// keep the stat descriptor open, reap its owned task, then perform the read.
func TestSupervisorRecognizesReapedProcDescriptorAndStillObservesAbsence(t *testing.T) {
	cmd, supervisor, root, done := supervisorExitFixture(t, true, nil)
	stat, err := os.Open("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/stat")
	if err != nil {
		t.Fatal(err)
	}
	defer stat.Close()
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("owned child was not reaped")
	}
	_, err = io.ReadAll(stat)
	if !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("read after reap error_type=%T, want ESRCH", err)
	}
	if !processLookupAbsent(err) {
		t.Fatal("reaped task read incorrectly classified as unknown")
	}
	observation, err := supervisor.Observe(context.Background(), root)
	if err != nil || !observation.Known || !observation.Quiescent || observation.Generation != 0 {
		t.Fatalf("reaped owned process absence not observed: known=%t quiescent=%t error_type=%T", observation.Known, observation.Quiescent, err)
	}
	if err = supervisor.Stop(context.Background(), root); err != nil {
		t.Fatalf("already reaped process stop error_type=%T", err)
	}
}

func TestSupervisorProcessLookupFixPreservesIdentityAndGroupFences(t *testing.T) {
	for _, tc := range []struct {
		name        string
		groupLeader bool
		mutate      func(*processRecord)
	}{
		{"start-ticks", true, func(p *processRecord) { p.StartTicks += "0" }},
		{"executable", true, func(p *processRecord) { p.Executable += ".different" }},
		{"process-group", false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd, supervisor, root, done := supervisorExitFixture(t, tc.groupLeader, tc.mutate)
			if observation, err := supervisor.Observe(context.Background(), root); err == nil || observation.Known {
				t.Fatal("mismatched ownership was reported as known")
			}
			if err := supervisor.Stop(context.Background(), root); err == nil {
				t.Fatal("mismatched ownership stop did not fail closed")
			}
			select {
			case <-done:
				t.Fatal("mismatched process was signaled")
			case <-time.After(20 * time.Millisecond):
			}
			if _, _, alive, err := processIdentity(cmd.Process.Pid); err != nil || !alive {
				t.Fatalf("mismatched owned fixture was not left alive: alive=%t error_type=%T", alive, err)
			}
		})
	}
}

func supervisorExitFixture(t *testing.T, groupLeader bool, mutate func(*processRecord)) (*exec.Cmd, *ProcessSupervisor, string, <-chan struct{}) {
	t.Helper()
	binary, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: groupLeader}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("owned fixture did not stop")
		}
	})
	start, executable, alive, err := processIdentity(cmd.Process.Pid)
	if err != nil || !alive {
		t.Fatalf("fixture identity alive=%t error_type=%T", alive, err)
	}
	boot, err := bootID()
	if err != nil {
		t.Fatal(err)
	}
	p := processRecord{PID: cmd.Process.Pid, StartTicks: start, Executable: executable, BootID: boot}
	if mutate != nil {
		mutate(&p)
	}
	root := t.TempDir()
	if err = writeJSON(processFile(root), p); err != nil {
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
	return cmd, supervisor, root, done
}
