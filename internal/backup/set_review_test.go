package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupSetReviewRejectsTrailingCiphertext(t *testing.T) {
	_, original, l := setFixture(t)
	for _, name := range []string{"manifest", "part", "authenticated_part_length_and_hash"} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "set")
			copySet(t, original, p)
			file := setManifestName
			if name != "manifest" {
				file = partName(1)
			}
			b, err := os.ReadFile(filepath.Join(p, file))
			if err != nil {
				t.Fatal(err)
			}
			b = append(b, []byte("unexpected trailing ciphertext")...)
			if err = os.WriteFile(filepath.Join(p, file), b, 0600); err != nil {
				t.Fatal(err)
			}
			if name == "authenticated_part_length_and_hash" {
				m := readManifestTest(t, p)
				m.Parts[0].Bytes = int64(len(b))
				h := sha256.Sum256(b)
				m.Parts[0].SHA256 = hex.EncodeToString(h[:])
				writeManifestTest(t, p, m)
			}
			out := t.TempDir()
			if err = RestoreSet(context.Background(), p, setPassword, filepath.Join(out, "fresh.db"), bytes.Repeat([]byte{42}, 32), l); err == nil {
				t.Fatal("accepted trailing ciphertext")
			}
			entries, err := os.ReadDir(out)
			if err != nil || len(entries) != 0 {
				t.Fatalf("partial output: %v %v", entries, err)
			}
		})
	}
}

func TestBackupSetReviewCreateRefusesOccupiedDirectoryAndSymlink(t *testing.T) {
	s, _, l := setFixture(t)
	for _, symlink := range []bool{false, true} {
		target := filepath.Join(t.TempDir(), "occupied")
		if symlink {
			if err := os.Symlink(t.TempDir(), target); err != nil {
				t.Fatal(err)
			}
		} else if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		before, err := os.Lstat(target)
		if err != nil {
			t.Fatal(err)
		}
		if err = CreateSet(context.Background(), s, setPassword, target, l); err == nil {
			t.Fatal("replaced occupied target")
		}
		after, err := os.Lstat(target)
		if err != nil || !os.SameFile(before, after) {
			t.Fatal("occupied target changed")
		}
	}
}

func TestBackupSetReviewConcurrentFreshPublication(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "published")
	dirs := []string{filepath.Join(root, "a"), filepath.Join(root, "b")}
	for _, dir := range dirs {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "marker"), []byte(filepath.Base(dir)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	result := make(chan error, 2)
	for _, dir := range dirs {
		go func(d string) { <-start; result <- publishSetDirectory(d, target) }(dir)
	}
	close(start)
	first, second := <-result, <-result
	if (first == nil) == (second == nil) {
		t.Fatalf("want one winner, got %v / %v", first, second)
	}
	b, err := os.ReadFile(filepath.Join(target, "marker"))
	if err != nil {
		t.Fatal(err)
	}
	loser := "a"
	if string(b) == "a" {
		loser = "b"
	} else if string(b) != "b" {
		t.Fatalf("invalid winner %q", b)
	}
	if b, err = os.ReadFile(filepath.Join(root, loser, "marker")); err != nil || string(b) != loser {
		t.Fatalf("loser altered: %q %v", b, err)
	}
}
