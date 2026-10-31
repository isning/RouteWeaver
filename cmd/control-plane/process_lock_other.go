//go:build !linux && !darwin

package main

import "fmt"

func acquireProcessLock(database string) (func(), error) {
	return nil, fmt.Errorf("control-plane process locking is supported only on Linux and macOS; refusing unsafe unlocked operation")
}
