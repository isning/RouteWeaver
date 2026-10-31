//go:build !linux && !darwin

package store

import "fmt"

func AcquireDatabaseProcessLock(database string) (func(), error) {
	return nil, fmt.Errorf("control-plane process locking is supported only on Linux and macOS; refusing unsafe unlocked operation")
}
