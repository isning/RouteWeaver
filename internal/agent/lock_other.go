//go:build !linux && !darwin && !freebsd

package agent

import (
	"errors"
	"os"
)

func lockRoot(string) (*os.File, error) {
	return nil, errors.New("local agent requires verified OS file locking")
}
func unlockRoot(f *os.File) error { return f.Close() }
