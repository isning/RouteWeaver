//go:build linux

package agent

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type processRecord struct {
	Identity   Identity `json:"identity"`
	PID        int      `json:"pid"`
	StartTicks string   `json:"startTicks"`
	BootID     string   `json:"bootId"`
	Executable string   `json:"executable"`
	Pending    bool     `json:"pending"`
	Absent     bool     `json:"absent"`
}

func processFile(root string) string { return filepath.Join(root, "owned-process.json") }
func bootID() (string, error) {
	b, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return strings.TrimSpace(string(b)), e
}
func processIdentity(pid int) (start, executable string, alive bool, err error) {
	if pid <= 1 {
		return "", "", false, errors.New("invalid owned PID")
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if errors.Is(err, os.ErrNotExist) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	// comm is parenthesized and may contain spaces or parentheses.
	end := strings.LastIndexByte(string(b), ')')
	if end < 0 {
		return "", "", false, errors.New("invalid process stat")
	}
	fields := strings.Fields(string(b[end+1:]))
	if len(fields) < 20 {
		return "", "", false, errors.New("short process stat")
	}
	if fields[0] == "Z" || fields[0] == "X" {
		return "", "", false, nil
	}
	executable, err = os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
	if errors.Is(err, os.ErrNotExist) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return fields[19], executable, true, nil
}
func (s *ProcessSupervisor) matches(p processRecord) (bool, error) {
	if p.Pending {
		return false, ErrUnknownRuntime
	}
	if p.Absent {
		return false, nil
	}
	currentBoot, err := bootID()
	if err != nil {
		return false, err
	}
	if currentBoot != p.BootID {
		return false, nil
	}
	start, exe, alive, err := processIdentity(p.PID)
	if err != nil {
		return false, err
	}
	if !alive {
		// A zombie leader still makes kill(-pgid, 0) succeed until cmd.Wait
		// reaps it. Wait only for proven group disappearance, never interpret
		// an existing group as safe or send a group signal. A real descendant
		// still blocks after this bounded reaping grace period.
		deadline := time.Now().Add(100 * time.Millisecond)
		for {
			groupErr := syscall.Kill(-p.PID, 0)
			if errors.Is(groupErr, syscall.ESRCH) {
				return false, nil
			}
			if groupErr != nil && !errors.Is(groupErr, syscall.EPERM) {
				return false, groupErr
			}
			if !time.Now().Before(deadline) {
				return false, errors.New("owned group has unobserved descendants")
			}
			time.Sleep(time.Millisecond)
		}
	}
	resolved, err := filepath.EvalSymlinks(s.checker.binary)
	if err != nil {
		return false, err
	}
	if p.StartTicks != start || p.Executable != exe || exe != resolved {
		return false, errors.New("owned process identity changed; no signal sent")
	}
	group, err := syscall.Getpgid(p.PID)
	if err != nil {
		return false, err
	}
	if group != p.PID {
		return false, errors.New("owned process group changed; no signal sent")
	}
	return true, nil
}
func (s *ProcessSupervisor) Observe(ctx context.Context, root string) (Observation, error) {
	if err := ctx.Err(); err != nil {
		return Observation{}, err
	}
	var p processRecord
	err := readJSON(processFile(root), &p)
	if errors.Is(err, os.ErrNotExist) {
		return Observation{Known: true, Quiescent: true, Evidence: "owned_process_liveness", ObservedAt: time.Now().UTC()}, nil
	}
	if err != nil {
		return Observation{}, err
	}
	alive, err := s.matches(p)
	if err != nil {
		return Observation{}, err
	}
	if !alive {
		return Observation{Known: true, Quiescent: true, Evidence: "owned_process_liveness", ObservedAt: time.Now().UTC()}, nil
	}
	return Observation{Identity: p.Identity, Known: true, Quiescent: true, Evidence: "owned_process_liveness", ObservedAt: time.Now().UTC()}, nil
}

// Stop checks boot ID, /proc start ticks, resolved executable and group leader
// before each signal. A pidfd pins the leader across PID reuse; no process-group
// signal is sent. Unobserved descendants block progress rather than being killed.
// The caller must hold the instance's Reconciler lock through its driver.
func (s *ProcessSupervisor) Stop(ctx context.Context, root string) error {
	var p processRecord
	err := readJSON(processFile(root), &p)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	alive, err := s.matches(p)
	if err != nil {
		return err
	}
	if !alive {
		return nil
	}
	// Open a stable kernel process handle BEFORE final identity verification.
	// Signals can never retarget a recycled PID or process group.
	pidfd, err := unix.PidfdOpen(p.PID, 0)
	if err != nil {
		return errors.New("stable process handle unavailable; no signal sent")
	}
	defer unix.Close(pidfd)
	alive, err = s.matches(p)
	if err != nil {
		return err
	}
	if !alive {
		return nil
	}
	if err = unix.PidfdSendSignal(pidfd, syscall.SIGTERM, nil, 0); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.NewTimer(s.options.StopTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		alive, err = s.matches(p)
		if err != nil {
			return err
		}
		if !alive {
			p.Absent = true
			return writeJSON(processFile(root), p)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			// Re-check ownership immediately before escalating only this child group.
			alive, err = s.matches(p)
			if err != nil {
				return err
			}
			if alive {
				if err = unix.PidfdSendSignal(pidfd, syscall.SIGKILL, nil, 0); err != nil && !errors.Is(err, syscall.ESRCH) {
					return err
				}
			}
			end := time.NewTimer(time.Second)
			defer end.Stop()
			for {
				alive, err = s.matches(p)
				if err != nil {
					return err
				}
				if !alive {
					p.Absent = true
					return writeJSON(processFile(root), p)
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-end.C:
					return ErrUnknownRuntime
				case <-tick.C:
				}
			}
		case <-tick.C:
		}
	}
}
func (s *ProcessSupervisor) Activate(ctx context.Context, st Staged) error {
	if err := ctx.Err(); err != nil {
		return &NotAppliedError{Code: "cancelled_before_process_activation"}
	}
	// Validate before stopping a previously owned process. No shell or API reload.
	if st.nativeReceipt != nil {
		if err := s.checker.verifyReceipt(st); err != nil {
			return &NotAppliedError{Code: "validated_activation_inputs_changed"}
		}
	} else if err := s.checker.Validate(ctx, st); err != nil {
		return &NotAppliedError{Code: "validation_changed_before_activation"}
	}
	if err := s.Stop(ctx, st.Root); err != nil {
		return err
	}
	p := processRecord{Identity: st.Desired.Identity(), Pending: true}
	if err := writeJSON(processFile(st.Root), p); err != nil {
		return err
	}
	args := s.checker.commands.RunArgs(st)
	cmd := exec.Command(s.checker.binary, args...)
	cmd.Dir = st.Directory
	cmd.Env = nativeProcessEnvironment(st.Directory, s.checker.stagedEnvironment(st))
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	var processIO *ProcessIO
	if s.checker.commands.PrepareProcess != nil {
		var setupErr error
		processIO, setupErr = s.checker.commands.PrepareProcess(st)
		if setupErr != nil {
			p.Pending = false
			p.Absent = true
			_ = writeJSON(processFile(st.Root), p)
			return setupErr
		}
		cmd.ExtraFiles = processIO.ExtraFiles
	}
	if err := cmd.Start(); err != nil {
		if processIO != nil && processIO.OnExit != nil {
			processIO.OnExit()
		}

		p.Pending = false
		p.Absent = true
		_ = writeJSON(processFile(st.Root), p)
		return errors.New("owned process launch failed")
	}
	if processIO != nil && processIO.AfterStart != nil {
		processIO.AfterStart()
	}
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		if processIO != nil && processIO.OnExit != nil {
			processIO.OnExit()
		}
		done <- err
	}()
	// Until the durable identity is complete, terminate only the direct child
	// handle we just created if setup fails. Never leave an untracked success.
	cleanup := func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
	p.PID = cmd.Process.Pid
	var alive bool
	var err error
	p.StartTicks, p.Executable, alive, err = processIdentity(p.PID)
	if err != nil || !alive {
		cleanup()
		// A child may have spawned descendants before its identity was read.
		// Keep the pending ownership fence; never infer group absence from
		// the direct child exit alone.
		_ = writeJSON(processFile(st.Root), p)
		return ErrUnknownRuntime
	}
	p.BootID, err = bootID()
	if err != nil {
		cleanup()
		return err
	}
	p.Pending = false
	if err = writeJSON(processFile(st.Root), p); err != nil {
		cleanup()
		return err
	}
	timer := time.NewTimer(s.options.StartupGrace)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		cleanup()
		if err := s.recordStartupAbsence(st.Root, p); err != nil {
			return err
		}
		return ctx.Err()
	case <-done:
		if err := s.recordStartupAbsence(st.Root, p); err != nil {
			return err
		}
		return errors.New("owned process exited during startup")
	case <-timer.C:
	}
	alive, err = s.matches(p)
	if err != nil || !alive {
		return ErrUnknownRuntime
	}
	return nil
}

// A reaped leader does not prove an empty process group. Retain the complete
// ownership record when descendants/identity are unknown; Observe can retry
// later, without permission to signal an unverified process or replay launch.
func (s *ProcessSupervisor) recordStartupAbsence(root string, p processRecord) error {
	alive, err := s.matches(p)
	if err != nil || alive {
		return ErrUnknownRuntime
	}
	p.Absent = true
	return writeJSON(processFile(root), p)
}
