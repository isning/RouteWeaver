//go:build !linux

package store

// Unsupported filesystem observations are unknown, never reported as zero.
func historyAvailableBytes(string) *uint64 { return nil }
