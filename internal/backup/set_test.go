package backup

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filippo.io/age"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"sync"
	"testing"
	"time"
)

const setPassword = "synthetic-set-long-passphrase"

func smallSetLimits() SetLimits {
	return SetLimits{TotalBytes: 2 << 20, TotalRows: 100, PartBytes: 32 << 10, PartRows: 2, RecordBytes: 8 << 10, Parts: 32, Duration: time.Minute, DiskBytes: 256 << 20}
}
func setSourceFixture(t *testing.T) *store.Store {
	t.Helper()
	s, e := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{31}, 32))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if e = s.Put("ledger", id, map[string]string{"evidence": id}); e != nil {
			t.Fatal(e)
		}
	}
	return s
}
func setFixture(t *testing.T) (*store.Store, string, SetLimits) {
	t.Helper()
	s := setSourceFixture(t)
	path := filepath.Join(t.TempDir(), "set")
	l := smallSetLimits()
	if e := CreateSet(context.Background(), s, setPassword, path, l); e != nil {
		t.Fatal(e)
	}
	return s, path, l
}
func TestBackupSetRoundTripAndFreshPublication(t *testing.T) {
	path, l := immutableSetFixture(t)
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{32}, 32)
	if e := RestoreSet(context.Background(), path, setPassword, target, key, l); e != nil {
		t.Fatal(e)
	}
	s, e := store.Open(target, key)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		var v map[string]string
		if e = s.Get("ledger", id, &v); e != nil || v["evidence"] != id {
			t.Fatalf("lost %s: %v", id, e)
		}
	}
	if e = RestoreSet(context.Background(), path, setPassword, target, key, l); e == nil {
		t.Fatal("replaced occupied target")
	}
}
func TestBackupSetRejectsCorruptionAndCleansPrivateStage(t *testing.T) {
	original, l := immutableSetFixture(t)
	cases := map[string]func(string){
		"missing": func(p string) { os.Remove(filepath.Join(p, partName(1))) },
		"truncated": func(p string) {
			f, _ := os.OpenFile(filepath.Join(p, partName(1)), os.O_WRONLY, 0600)
			f.Truncate(100)
			f.Close()
		},
		"tampered": func(p string) {
			f, _ := os.OpenFile(filepath.Join(p, partName(1)), os.O_WRONLY, 0600)
			f.WriteAt([]byte{0xff}, 200)
			f.Close()
		},
		"reordered": func(p string) {
			a, _ := os.ReadFile(filepath.Join(p, partName(1)))
			b, _ := os.ReadFile(filepath.Join(p, partName(2)))
			os.WriteFile(filepath.Join(p, partName(1)), b, 0600)
			os.WriteFile(filepath.Join(p, partName(2)), a, 0600)
		},
		"extra": func(p string) { os.WriteFile(filepath.Join(p, "extra.age"), []byte("x"), 0600) },
		"symlink": func(p string) {
			os.Remove(filepath.Join(p, partName(1)))
			os.Symlink(filepath.Join(original, partName(1)), filepath.Join(p, partName(1)))
		},
		"manifest_truncated": func(p string) { os.WriteFile(filepath.Join(p, setManifestName), []byte("age"), 0600) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "set")
			copySet(t, original, p)
			mutate(p)
			outDir := t.TempDir()
			target := filepath.Join(outDir, "fresh.db")
			if e := RestoreSet(context.Background(), p, setPassword, target, bytes.Repeat([]byte{32}, 32), l); e == nil {
				t.Fatal("accepted corruption")
			}
			entries, _ := os.ReadDir(outDir)
			if len(entries) != 0 {
				t.Fatalf("left partial output: %v", entries)
			}
		})
	}
}
func copySet(t *testing.T, src, dst string) {
	t.Helper()
	if e := os.Mkdir(dst, 0700); e != nil {
		t.Fatal(e)
	}
	entries, _ := os.ReadDir(src)
	for _, entry := range entries {
		b, e := os.ReadFile(filepath.Join(src, entry.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(dst, entry.Name()), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
func TestBackupSetExplicitBudgetsAndCancellation(t *testing.T) {
	s, base := setSourceFixture(t), smallSetLimits()
	for _, name := range []string{"rows", "parts", "record", "bytes", "disk", "duration"} {
		t.Run(name, func(t *testing.T) {
			l := base
			switch name {
			case "rows":
				l.TotalRows = 1
			case "parts":
				l.Parts = 1
			case "record":
				l.RecordBytes = 1
			case "bytes":
				l.TotalBytes = 200
			case "disk":
				l.DiskBytes = 1
			case "duration":
				l.Duration = 0
			}
			dir := t.TempDir()
			if e := CreateSet(context.Background(), s, setPassword, filepath.Join(dir, "set"), l); e == nil {
				t.Fatal("accepted budget overrun")
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 0 {
				t.Fatal("left incomplete set")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dir := t.TempDir()
	if e := CreateSet(ctx, s, setPassword, filepath.Join(dir, "set"), base); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancel: %v", e)
	}
}
func TestBackupSetAuthenticatedManifestRejectsDuplicateAndMixedParts(t *testing.T) {
	original, l := immutableSetFixture(t)
	_, other, _ := setFixture(t) // intentionally distinct snapshot/key for mixed-set rejection
	originalManifest := readManifestTest(t, original)
	for _, name := range []string{"duplicate", "mixed", "global_digest", "schema"} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "set")
			copySet(t, original, p)
			m := originalManifest
			m.Parts = append([]setPart(nil), originalManifest.Parts...)
			switch name {
			case "duplicate":
				m.Parts[1] = m.Parts[0]
			case "mixed":
				b, _ := os.ReadFile(filepath.Join(other, partName(1)))
				os.WriteFile(filepath.Join(p, partName(1)), b, 0600)
			case "global_digest":
				m.SHA256 = string(bytes.Repeat([]byte{'0'}, 64))
			case "schema":
				m.SchemaVersion++
			}
			if name != "mixed" {
				writeManifestTest(t, p, m)
			}
			out := t.TempDir()
			if e := RestoreSet(context.Background(), p, setPassword, filepath.Join(out, "fresh.db"), bytes.Repeat([]byte{32}, 32), l); e == nil {
				t.Fatal("accepted invalid set")
			}
			entries, _ := os.ReadDir(out)
			if len(entries) != 0 {
				t.Fatal("left staged target")
			}
		})
	}
}
func readManifestTest(t *testing.T, p string) setManifest {
	t.Helper()
	f, e := os.Open(filepath.Join(p, setManifestName))
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	id, _ := age.NewScryptIdentity(setPassword)
	r, e := age.Decrypt(f, id)
	if e != nil {
		t.Fatal(e)
	}
	b, e := io.ReadAll(r)
	if e != nil {
		t.Fatal(e)
	}
	var m setManifest
	if e = json.Unmarshal(b, &m); e != nil {
		t.Fatal(e)
	}
	return m
}
func writeManifestTest(t *testing.T, p string, m setManifest) {
	t.Helper()
	r, _ := age.NewScryptRecipient(setPassword)
	r.SetWorkFactor(workFactor)
	f, e := os.Create(filepath.Join(p, setManifestName))
	if e != nil {
		t.Fatal(e)
	}
	w, e := age.Encrypt(f, r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := canonical(m)
	w.Write(b)
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	f.Close()
}

func TestBackupSetManifestFailsClosedInOlderStreamReader(t *testing.T) {
	path, _ := immutableSetFixture(t)
	f, e := os.Open(filepath.Join(path, setManifestName))
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	p, e := PreviewStream(context.Background(), f, setPassword, DefaultLimits())
	if e == nil {
		p.Close()
		t.Fatal("v2 reader accepted v3 set manifest")
	}
}
func TestBackupSetWrongPasswordAndPartByteBoundary(t *testing.T) {
	s, path, l := setFixture(t)
	out := t.TempDir()
	if e := RestoreSet(context.Background(), path, "wrong-synthetic-passphrase", filepath.Join(out, "fresh"), bytes.Repeat([]byte{32}, 32), l); e == nil {
		t.Fatal("accepted wrong password")
	}
	if e := s.Put("ledger", "large", map[string]string{"evidence": string(bytes.Repeat([]byte{'x'}, 7000))}); e != nil {
		t.Fatal(e)
	}
	l.PartBytes = 8192
	if e := CreateSet(context.Background(), s, setPassword, filepath.Join(out, "small-part"), l); !errors.Is(e, ErrBackupSetRecordSize) {
		t.Fatalf("record boundary: %v", e)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatal("left output after failures")
	}
}

func TestBackupSetAuthenticatedFramesStillRequireGlobalRelationships(t *testing.T) {
	s, l := setSourceFixture(t), smallSetLimits()
	if e := s.EnsureAdmin("operator", "synthetic-long-admin-password"); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "set")
	if e := CreateSet(context.Background(), s, setPassword, path, l); e != nil {
		t.Fatal(e)
	}
	m := readManifestTest(t, path)
	id, e := age.ParseX25519Identity(m.Identity)
	if e != nil {
		t.Fatal(e)
	}
	var frames []store.BackupFrame
	for _, p := range m.Parts {
		f, e := os.Open(filepath.Join(path, p.Name))
		if e != nil {
			t.Fatal(e)
		}
		r, e := age.Decrypt(f, id)
		if e != nil {
			t.Fatal(e)
		}
		scanner := bufio.NewScanner(r)
		for scanner.Scan() {
			var line setLine
			if e = json.Unmarshal(scanner.Bytes(), &line); e != nil {
				t.Fatal(e)
			}
			if line.Frame != nil && line.Frame.Identity == nil {
				frames = append(frames, *line.Frame)
			}
		}
		if e = scanner.Err(); e != nil {
			t.Fatal(e)
		}
		f.Close()
	}
	// Deliberately omit an account's identity while recomputing every authenticated
	// digest and footer. Per-part validity must not bypass whole-database checks.
	for _, p := range m.Parts {
		os.Remove(filepath.Join(path, p.Name))
	}
	m.Parts = nil
	m.Rows = 0
	global := sha256.New()
	for i, f := range frames {
		var cipher bytes.Buffer
		w, e := age.Encrypt(&cipher, id.Recipient())
		if e != nil {
			t.Fatal(e)
		}
		b, _ := canonical(setLine{Header: &setHeader{Format: setFormat, Version: SetVersion, ID: m.ID, Index: i + 1}})
		w.Write(b)
		b, _ = canonical(setLine{Frame: &f})
		w.Write(b)
		c, _ := canonical(f)
		h := sha256.New()
		h.Write(c)
		global.Write(c)
		b, _ = canonical(setLine{Footer: &setFooter{Rows: 1, SHA256: digest(h)}})
		w.Write(b)
		if e = w.Close(); e != nil {
			t.Fatal(e)
		}
		name := partName(i + 1)
		if e = os.WriteFile(filepath.Join(path, name), cipher.Bytes(), 0600); e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(cipher.Bytes())
		m.Parts = append(m.Parts, setPart{Name: name, Bytes: int64(cipher.Len()), Rows: 1, SHA256: hex.EncodeToString(sum[:])})
		m.Rows++
	}
	m.SHA256 = digest(global)
	writeManifestTest(t, path, m)
	out := t.TempDir()
	if e = RestoreSet(context.Background(), path, setPassword, filepath.Join(out, "fresh"), bytes.Repeat([]byte{32}, 32), l); e == nil {
		t.Fatal("restored authenticated but globally incomplete account")
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatal("published incomplete relationship")
	}
}

func TestBackupSetCancelledRestorePublishesNothing(t *testing.T) {
	path, l := immutableSetFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := t.TempDir()
	if e := RestoreSet(ctx, path, setPassword, filepath.Join(out, "target"), bytes.Repeat([]byte{32}, 32), l); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancel error: %v", e)
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatal("published cancelled restore")
	}
}

func TestBackupSetRejectsRestoreWorkspaceInsideInput(t *testing.T) {
	set, l := immutableSetFixture(t)
	original, _ := os.ReadDir(set)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(set, alias); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{filepath.Join(set, "fresh.db"), filepath.Join(alias, "fresh.db"), filepath.Join(set, "nested", "fresh.db")} {
		if err := RestoreSet(context.Background(), set, setPassword, target, bytes.Repeat([]byte{32}, 32), l); err == nil || !strings.Contains(err.Error(), "outside the input") {
			t.Fatalf("inside target %s: %v", target, err)
		}
	}
	after, _ := os.ReadDir(set)
	if len(after) != len(original) {
		t.Fatal("input set was mutated")
	}
	// The original set remains usable after every rejected overlap.
	if err := RestoreSet(context.Background(), set, setPassword, filepath.Join(t.TempDir(), "fresh.db"), bytes.Repeat([]byte{32}, 32), l); err != nil {
		t.Fatal(err)
	}
}

func TestBackupSetRejectsSourceSQLitePathFamily(t *testing.T) {
	parent := t.TempDir()
	path := filepath.Join(parent, "source.db")
	key := bytes.Repeat([]byte{37}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	alias := filepath.Join(t.TempDir(), "source-parent")
	if err = os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	err = store.WithOfflineBackupSource(ctx, path, key, func(source *store.Store) error {
		for _, base := range []string{parent, alias} {
			for _, suffix := range []string{"-wal", "-shm", "-journal"} {
				target := filepath.Join(base, "source.db"+suffix)
				if err := CreateSet(ctx, source, setPassword, target, smallSetLimits()); err == nil || !strings.Contains(err.Error(), "source database or SQLite sidecar") {
					t.Fatalf("source family output %s: %v", suffix, err)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatalf("source no longer usable: %v", err)
	}
	reopened.Close()
}

var immutableSetCache struct {
	sync.Once
	files map[string][]byte
}

// Cache only synthetic ciphertext, never a mutable filesystem directory or live
// Store. Every test gets owned copies. The real CreateSet still runs once per
// test process with the production scrypt work factor; independent snapshots
// for mixed-set rejection are always separately generated.
func immutableSetFixture(t *testing.T) (string, SetLimits) {
	t.Helper()
	immutableSetCache.Do(func() {
		_, source, _ := setFixture(t)
		entries, err := os.ReadDir(source)
		if err != nil {
			t.Fatal(err)
		}
		files := make(map[string][]byte, len(entries))
		for _, entry := range entries {
			b, err := os.ReadFile(filepath.Join(source, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			files[entry.Name()] = b
		}
		immutableSetCache.files = files
	})
	if len(immutableSetCache.files) == 0 {
		t.Fatal("immutable fixture initialization failed")
	}
	path := filepath.Join(t.TempDir(), "set")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	for name, b := range immutableSetCache.files {
		if err := os.WriteFile(filepath.Join(path, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path, smallSetLimits()
}

func TestBackupSetRejectsNestedSourceSidecarDestination(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	// Find the source through a dedicated path to exercise the public destination guard.
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{39}, 32)
	s2, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	target := filepath.Join(path+"-journal", "nested")
	if err = CreateSet(ctx, s2, setPassword, target, smallSetLimits()); err == nil || !strings.Contains(err.Error(), "SQLite sidecar") {
		t.Fatalf("nested sidecar destination: %v", err)
	}
	if _, err = os.Lstat(path + "-journal"); !os.IsNotExist(err) {
		t.Fatal("created source journal directory")
	}
}
