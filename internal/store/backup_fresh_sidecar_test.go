package store

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRestoreFreshRejectsOccupiedSQLiteSidecars(t *testing.T) {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		for _, shape := range []string{"file", "directory", "symlink"} {
			t.Run(suffix+"/"+shape, func(t *testing.T) {
				source, err := Open(filepath.Join(t.TempDir(), "source.db"), make([]byte, 32))
				if err != nil {
					t.Fatal(err)
				}
				defer source.Close()
				if err = source.Put("audit", "keep", map[string]string{"action": "unchanged"}); err != nil {
					t.Fatal(err)
				}
				var sourceBefore []byte
				if err = source.db.QueryRow(`SELECT data FROM records WHERE kind='audit' AND id='keep'`).Scan(&sourceBefore); err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				target := filepath.Join(dir, "output.db")
				sidecar := target + suffix
				switch shape {
				case "file":
					err = os.WriteFile(sidecar, []byte("caller-owned"), 0600)
				case "directory":
					err = os.Mkdir(sidecar, 0700)
				case "symlink":
					if runtime.GOOS == "windows" {
						t.Skip("symlink fixture requires local symlink permission")
					}
					err = os.Symlink(filepath.Join(dir, "missing-owner-target"), sidecar)
				}
				if err != nil {
					t.Fatal(err)
				}
				before, err := os.Lstat(sidecar)
				if err != nil {
					t.Fatal(err)
				}
				if err = RestoreBackupFresh(context.Background(), target, make([]byte, 32), source, BackupLimits{MaxBytes: 1 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}); err == nil {
					t.Fatal("occupied sidecar accepted")
				}
				if _, err = os.Lstat(target); !os.IsNotExist(err) {
					t.Fatal("main file published on admission refusal")
				}
				after, err := os.Lstat(sidecar)
				if err != nil || !os.SameFile(before, after) {
					t.Fatal("caller-owned sidecar replaced/removed")
				}
				if shape == "file" {
					got, err := os.ReadFile(sidecar)
					if err != nil || string(got) != "caller-owned" {
						t.Fatal("sidecar content changed")
					}
				}
				var sourceAfter []byte
				if err = source.db.QueryRow(`SELECT data FROM records WHERE kind='audit' AND id='keep'`).Scan(&sourceAfter); err != nil || !bytes.Equal(sourceBefore, sourceAfter) {
					t.Fatal("refusal changed source")
				}
			})
		}
	}
}
func TestFreshPublicationRechecksSidecarsAfterAdmission(t *testing.T) {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		t.Run(suffix, func(t *testing.T) {
			dir := t.TempDir()
			verified := filepath.Join(dir, "verified.db")
			target := filepath.Join(dir, "output.db")
			if err := os.WriteFile(verified, []byte("verified-source"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := freshDatabaseTarget(target); err != nil {
				t.Fatal(err)
			}
			// Simulate a sidecar appearing while restore verification is in progress.
			if err := os.WriteFile(target+suffix, []byte("arrived-after-admission"), 0600); err != nil {
				t.Fatal(err)
			}
			linked := false
			err := publishFreshBackupWithOps(context.Background(), verified, target, backupPublicationOps{link: func(a, b string) error { linked = true; return os.Link(a, b) }, syncParent: syncBackupParent, remove: os.Remove})
			if err == nil || linked {
				t.Fatal("late sidecar reached publication")
			}
			if _, err = os.Lstat(target); !os.IsNotExist(err) {
				t.Fatal("late refusal created target")
			}
			b, err := os.ReadFile(verified)
			if err != nil || string(b) != "verified-source" {
				t.Fatal("verified source modified")
			}
			b, err = os.ReadFile(target + suffix)
			if err != nil || string(b) != "arrived-after-admission" {
				t.Fatal("caller sidecar modified")
			}
		})
	}
}
func TestRestoreFreshCanonicalAliasesAndSourceSidecarNames(t *testing.T) {
	sourcePath := filepath.Join(t.TempDir(), "source.db")
	source, err := Open(sourcePath, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	limits := BackupLimits{MaxBytes: 1 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}
	// The journal path is absent but still belongs to the source database.
	if err = RestoreBackupFresh(context.Background(), sourcePath+"-journal", make([]byte, 32), source, limits); err == nil {
		t.Fatal("source sidecar filename accepted as restore target")
	}
	if _, err = os.Lstat(sourcePath + "-journal"); !os.IsNotExist(err) {
		t.Fatal("source journal created")
	}
	if runtime.GOOS == "windows" {
		t.Skip("directory symlink fixture requires local permission")
	}
	actual := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if err = os.Symlink(actual, alias); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(alias, "output.db")
	if err = os.WriteFile(filepath.Join(actual, "output.db-wal"), []byte("canonical-sidecar"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = RestoreBackupFresh(context.Background(), target, make([]byte, 32), source, limits); err == nil {
		t.Fatal("canonical parent alias bypassed sidecar refusal")
	}
	if _, err = os.Lstat(filepath.Join(actual, "output.db")); !os.IsNotExist(err) {
		t.Fatal("canonical target published")
	}
}
