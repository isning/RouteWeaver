package store

import (
	"errors"
	"os"
)

var sqliteDatabasePathSuffixes = []string{"", "-wal", "-shm", "-journal"}

// freshDatabaseTarget checks raw AND canonical paths, preserving every occupied
// caller-owned name, including dangling symlinks and directories. A fresh main
// file beside an old WAL/hot journal is not a fresh database. These checks assume
// an operator-private directory with no concurrent hostile namespace changes;
// they are not an atomic reservation of multiple filesystem names.
func freshDatabaseTarget(path string) (string, error) {
	if err := requireAbsentSQLitePathFamily(path); err != nil {
		return "", err
	}
	canonical, err := CanonicalDatabasePath(path)
	if err != nil {
		return "", err
	}
	if err = requireAbsentSQLitePathFamily(canonical); err != nil {
		return "", err
	}
	return canonical, nil
}
func requireAbsentSQLitePathFamily(path string) error {
	for _, suffix := range sqliteDatabasePathSuffixes {
		if _, err := os.Lstat(path + suffix); err == nil {
			return errors.New("destination database or SQLite sidecar already exists; choose a fresh path")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func rejectSourceSQLitePathFamily(source, target string) error {
	for _, suffix := range sqliteDatabasePathSuffixes {
		if target == source+suffix {
			return errors.New("destination must not use a source database or SQLite sidecar path")
		}
	}
	return nil
}
