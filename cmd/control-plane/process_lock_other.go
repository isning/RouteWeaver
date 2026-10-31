//go:build !linux && !darwin

package main

import "routeweaver/internal/store"

func acquireProcessLock(database string) (func(), error) {
	return store.AcquireDatabaseProcessLock(database)
}
