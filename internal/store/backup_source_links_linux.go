//go:build linux

package store

import (
	"errors"
	"os"
	"syscall"
)

// A hardlink alias has the same lock inode but a different WAL basename. Refuse
// it rather than exporting a stale main file without its committed WAL state.
func requireSingleLinkBackupSource(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 {
		return errors.New("offline backup source must have exactly one filesystem link; hardlink WAL aliases are unsupported")
	}
	return nil
}
