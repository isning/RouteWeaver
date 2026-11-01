//go:build linux

package backup

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
)

func publishSetDirectory(source, target string) error {
	// Atomic no-replace also refuses an existing empty directory or symlink.
	if err := unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(target))
	if err == nil {
		err = parent.Sync()
		parent.Close()
	}
	if err != nil {
		return errors.Join(store.ErrRestorePublicationUncertain, err)
	}
	return nil
}

// Available space is a preflight observation, never a reservation. Runtime
// writers still enforce byte/page limits and propagate ENOSPC without publish.
func checkSetFreeSpace(path string, required int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return err
	}
	if stat.Bsize <= 0 || stat.Bavail < uint64((required+int64(stat.Bsize)-1)/int64(stat.Bsize)) {
		return errors.New("insufficient observed free space for explicit backup-set workspace envelope")
	}
	return nil
}
