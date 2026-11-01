//go:build linux

package store

import "syscall"

func historyAvailableBytes(path string) *uint64 {
	var stat syscall.Statfs_t
	if syscall.Statfs(path, &stat) != nil || stat.Bsize <= 0 {
		return nil
	}
	block := uint64(stat.Bsize)
	if stat.Bavail > ^uint64(0)/block {
		return nil
	}
	n := stat.Bavail * block
	return &n
}
