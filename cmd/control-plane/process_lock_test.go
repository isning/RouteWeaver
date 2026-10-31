//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProcessLockPreventsRecoveryAlongsideServer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db")
	release, e := acquireProcessLock(path)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := acquireProcessLock(path); e == nil {
		other()
		t.Fatal("second process lock accepted")
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if e = os.Symlink(dir, alias); e != nil {
		t.Fatal(e)
	}
	if other, e := acquireProcessLock(filepath.Join(alias, "db")); e == nil {
		other()
		t.Fatal("symlink bypass accepted")
	}
	hardlink := filepath.Join(t.TempDir(), "db-hardlink")
	if e = os.Link(path, hardlink); e != nil {
		t.Fatal(e)
	}
	if other, e := acquireProcessLock(hardlink); e == nil {
		other()
		t.Fatal("hardlink bypass accepted")
	}
	release()
	other, e := acquireProcessLock(path)
	if e != nil {
		t.Fatal(e)
	}
	other()
}
