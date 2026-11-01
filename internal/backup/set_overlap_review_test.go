package backup

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
)

func TestBackupSetReviewRejectsRestoreInsideInputSet(t *testing.T) {
	_, set, l := setFixture(t)
	alias := filepath.Join(t.TempDir(), "input-alias")
	if err := os.Symlink(set, alias); err != nil {
		t.Fatal(err)
	}
	for name, parent := range map[string]string{"direct": set, "symlink_parent": alias} {
		t.Run(name, func(t *testing.T) {
			key := bytes.Repeat([]byte{53}, 32)
			before, err := os.ReadDir(set)
			if err != nil {
				t.Fatal(err)
			}
			err = RestoreSet(context.Background(), set, setPassword, filepath.Join(parent, "restored.db"), key, l)
			if err == nil {
				t.Fatal("restore published inside its read-only input set")
			}
			after, err := os.ReadDir(set)
			if err != nil || len(after) != len(before) {
				t.Fatalf("input inventory changed: %d to %d, err %v", len(before), len(after), err)
			}
		})
	}
}

func TestBackupSetReviewRejectsSourceSQLiteSidecarTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	s, err := store.Open(path, bytes.Repeat([]byte{54}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	alias := filepath.Join(t.TempDir(), "source-parent-alias")
	if err = os.Symlink(filepath.Dir(path), alias); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"main": path, "journal": path + "-journal", "journal_alias": filepath.Join(alias, filepath.Base(path)+"-journal")} {
		t.Run(name, func(t *testing.T) {
			if err := CreateSet(context.Background(), s, setPassword, target, smallSetLimits()); err == nil {
				t.Fatal("published set into source SQLite path family")
			}
			if name != "main" {
				if _, err := os.Lstat(target); !os.IsNotExist(err) {
					t.Fatalf("source family changed: %v", err)
				}
			}
		})
	}
}
