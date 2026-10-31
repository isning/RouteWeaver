package backup_test

import (
	"bytes"
	"context"
	"encoding/json"
	"filippo.io/age"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestAuthenticatedBackupRejectsWrongPasswordTruncationAndTampering(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{31}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("secrets", "fixture", map[string]string{"password": "recover-this-secret"}); err != nil {
		t.Fatal(err)
	}
	encrypted, err := backup.Create(context.Background(), s, "long-synthetic-backup-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(encrypted, []byte("age-encryption.org/v1\n")) || bytes.Contains(encrypted, []byte("recover-this-secret")) {
		t.Fatal("backup is not an opaque age container")
	}
	prepared, err := backup.Preview(encrypted, "long-synthetic-backup-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Summary().Manifest.Records != 2 || !prepared.Summary().Manifest.ContainsSecrets {
		t.Fatal("incomplete manifest")
	}
	for _, tc := range []struct {
		name     string
		data     []byte
		password string
	}{
		{"wrong password", encrypted, "wrong-synthetic-backup-passphrase"},
		{"truncated", encrypted[:len(encrypted)-1], "long-synthetic-backup-passphrase"},
		{"tampered", append(append([]byte{}, encrypted[:len(encrypted)-1]...), encrypted[len(encrypted)-1]^1), "long-synthetic-backup-passphrase"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := backup.Preview(tc.data, tc.password); err == nil {
				t.Fatal("invalid archive accepted")
			}
		})
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	if err = prepared.Restore(context.Background(), target, bytes.Repeat([]byte{32}, 32)); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, bytes.Repeat([]byte{32}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var secret map[string]string
	if err = restored.Get("secrets", "fixture", &secret); err != nil || secret["password"] != "recover-this-secret" {
		t.Fatal("secret not recoverable")
	}
}

func TestBackupValidatesCompleteAuthenticatedPayloadAndBounds(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{33}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	snapshot, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	manifest := backup.Manifest{Format: backup.Format, Version: backup.Version, SchemaVersion: store.BackupSchemaVersion, CreatedAt: time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC), Records: 1, ContainsSecrets: true}
	good := map[string]any{"manifest": manifest, "snapshot": snapshot}
	cases := []struct {
		name   string
		change func(map[string]any)
	}{
		{"schema mismatch", func(v map[string]any) { m := manifest; m.SchemaVersion = 999; v["manifest"] = m }},
		{"version mismatch", func(v map[string]any) { m := manifest; m.Version = 999; v["manifest"] = m }},
		{"record count mismatch", func(v map[string]any) { m := manifest; m.Records++; v["manifest"] = m }},
		{"concealed secrets", func(v map[string]any) { m := manifest; m.ContainsSecrets = false; v["manifest"] = m }},
		{"path traversal", func(v map[string]any) { v["path"] = "../../outside.db" }},
		{"extra executable schema", func(v map[string]any) { v["sql"] = "DROP TABLE records" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := map[string]any{"manifest": good["manifest"], "snapshot": good["snapshot"]}
			tc.change(v)
			plain, _ := json.Marshal(v)
			encrypted := encryptFixture(t, plain, 10)
			if _, err := backup.Preview(encrypted, "long-synthetic-backup-passphrase"); err == nil {
				t.Fatal("invalid authenticated payload accepted")
			}
		})
	}
	plain, _ := json.Marshal(good)
	for _, plain := range [][]byte{append(append([]byte{}, plain...), []byte(` {"extra":true}`)...), []byte(`{"manifest":`)} {
		if _, err := backup.Preview(encryptFixture(t, plain, 10), "long-synthetic-backup-passphrase"); err == nil {
			t.Fatal("incomplete or concatenated payload accepted")
		}
	}
	if _, err := backup.Preview(make([]byte, backup.MaxArchiveBytes+1), "long-synthetic-backup-passphrase"); err != backup.ErrSize {
		t.Fatal("archive size limit not enforced:", err)
	}
	oversized := bytes.Repeat([]byte{' '}, store.MaxSnapshotBytes+16385)
	if _, err := backup.Preview(encryptFixture(t, oversized, 10), "long-synthetic-backup-passphrase"); err != backup.ErrSize {
		t.Fatal("plaintext size limit not enforced:", err)
	}
	// An untrusted header cannot demand arbitrary KDF memory. No high-work
	// encryption is performed to construct this attacker-controlled header.
	encrypted := encryptFixture(t, plain, 10)
	expensive := bytes.Replace(encrypted, []byte(" 10\n"), []byte(" 30\n"), 1)
	if bytes.Equal(expensive, encrypted) {
		t.Fatal("fixture did not raise work factor")
	}
	if _, err := backup.Preview(expensive, "long-synthetic-backup-passphrase"); err == nil {
		t.Fatal("unbounded KDF accepted")
	}
	trailing := append(encryptFixture(t, plain, 10), []byte("trailing")...)
	if _, err := backup.Preview(trailing, "long-synthetic-backup-passphrase"); err == nil {
		t.Fatal("trailing ciphertext accepted")
	}
}
func encryptFixture(t *testing.T, plain []byte, work int) []byte {
	t.Helper()
	recipient, err := age.NewScryptRecipient("long-synthetic-backup-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	recipient.SetWorkFactor(work)
	var out bytes.Buffer
	w, err := age.Encrypt(&out, recipient)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
