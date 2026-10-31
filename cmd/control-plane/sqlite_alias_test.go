//go:build linux || darwin

package main

import (
	"bytes"
	"os"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestIndependentSQLiteURILockAlias(t *testing.T)   { checkIndependentAlias(t, "file:state.db") }
func TestIndependentSQLiteQueryLockAlias(t *testing.T) { checkIndependentAlias(t, "state.db?mode=rw") }
func checkIndependentAlias(t *testing.T, aliasPath string) {
	old, e := os.Getwd()
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	if e = os.Chdir(dir); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir(old)
	release, e := acquireProcessLock("state.db")
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	key := bytes.Repeat([]byte{91}, 32)
	live, e := store.Open("state.db", key)
	if e != nil {
		t.Fatal(e)
	}
	defer live.Close()
	if e = live.EnsureAdmin("synthetic-admin", "synthetic-original-password"); e != nil {
		t.Fatal(e)
	}
	aliasRelease, e := acquireProcessLock(aliasPath)
	if e != nil {
		t.Log("alias safely rejected", e)
		return
	}
	defer aliasRelease()
	alias, e := store.Open(aliasPath, key)
	if e != nil {
		t.Fatal(e)
	}
	defer alias.Close()
	if e = alias.RecoverAdministrator("synthetic-admin", "synthetic-temporary-password", "Independent alias regression", true, time.Now()); e != nil {
		t.Fatal(e)
	}
	if _, _, _, e = live.Login("synthetic-admin", "synthetic-temporary-password", "", time.Now()); e == nil {
		t.Fatalf("P1: %s alias recovered same database while original server lock remains held", aliasPath)
	}
}
