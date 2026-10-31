//go:build linux || darwin || freebsd

package agent

import (
	"errors"
	"os"
	"syscall"
)

func lockRoot(root string) (*os.File, error) {
	f, err := os.OpenFile(root+"/.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("agent storage already locked")
	}
	return f, nil
}
func unlockRoot(f *os.File) error { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); return f.Close() }
