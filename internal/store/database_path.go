package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CanonicalDatabasePath accepts filesystem paths, not SQLite URI/DSN options.
// The exact returned path must be used for both the process inode lock and SQL.
// In particular modernc strips ?query even on non-file:-prefixed paths.
func CanonicalDatabasePath(path string) (string, error) {
	if path == "" || path == ":memory:" || strings.HasPrefix(strings.ToLower(path), "file:") || strings.ContainsAny(path, "?#\x00") {
		return "", fmt.Errorf("database must be a plain filesystem path, not a SQLite URI/DSN")
	}
	absolute, e := filepath.Abs(path)
	if e != nil {
		return "", e
	}
	// Resolve the deepest existing ancestor without creating directories. This
	// also covers an existing database symlink and symlinks above new directories.
	ancestor := absolute
	missing := []string{}
	for {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			if strings.ContainsAny(resolved, "?#\x00") {
				return "", fmt.Errorf("database symlink resolves to an unsupported SQLite DSN path")
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", err
		}
		missing = append(missing, filepath.Base(ancestor))
		ancestor = parent
	}
}
