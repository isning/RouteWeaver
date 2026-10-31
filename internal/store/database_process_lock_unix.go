//go:build linux || darwin

package store

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireDatabaseProcessLock is opt-in: Store.Open does not acquire it.
// All control-plane processes take this lock for their entire lifetime. Never
// replace/unlink the live database: the lock follows its inode (including hard
// links), not a pathname. SQLite locking remains independent of this flock.
func AcquireDatabaseProcessLock(database string) (func(), error) {
	absolute, e := CanonicalDatabasePath(database)
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Dir(absolute), 0700); e != nil {
		return nil, e
	}
	fd, e := syscall.Open(absolute, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), absolute)
	if e = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fmt.Errorf("control-plane database is in use; stop every server before offline recovery: %w", e)
	}
	return func() { syscall.Flock(fd, syscall.LOCK_UN); f.Close() }, nil
}
