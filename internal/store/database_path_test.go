package store_test

import (
	"bytes"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestStoreRejectsSQLiteDSNAliases(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, name := range []string{"file:state.db", "state.db?mode=rw", ":memory:", "state.db#fragment"} {
		t.Run(name, func(t *testing.T) {
			path := name
			if name != "file:state.db" && name != ":memory:" {
				path = filepath.Join(t.TempDir(), name)
			}
			s, e := store.Open(path, bytes.Repeat([]byte{82}, 32))
			if e == nil {
				s.Close()
				t.Fatal("SQLite DSN or ambiguous path accepted")
			}
			if _, e = os.Stat(path); !os.IsNotExist(e) {
				t.Fatalf("invalid input created a file: %v", e)
			}
		})
	}
}

func TestCanonicalDatabasePathResolvesExistingAncestorsWithoutCreatingFiles(t *testing.T) {
	real := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if e := os.Symlink(real, alias); e != nil {
		t.Fatal(e)
	}
	realCanonical, e := filepath.EvalSymlinks(real)
	if e != nil {
		t.Fatal(e)
	}
	candidate := filepath.Join(alias, "new", "nested", "state.db")
	got, e := store.CanonicalDatabasePath(candidate)
	if e != nil || got != filepath.Join(realCanonical, "new", "nested", "state.db") {
		t.Fatalf("canonical path %q %v", got, e)
	}
	if _, e = os.Stat(filepath.Join(real, "new")); !os.IsNotExist(e) {
		t.Fatal("normalization created filesystem state")
	}
	weird := filepath.Join(real, "state.db?mode=rw")
	if e = os.WriteFile(weird, nil, 0600); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(real, "innocent.db")
	if e = os.Symlink(weird, link); e != nil {
		t.Fatal(e)
	}
	if _, e = store.CanonicalDatabasePath(link); e == nil {
		t.Fatal("symlink target reintroduced SQLite DSN semantics")
	}
}
