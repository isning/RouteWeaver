// Package backup wraps complete logical store snapshots in the standard age
// authenticated-encryption container. Plaintext and passphrases never touch disk.
package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"routeweaver/internal/store"
	"strings"
	"time"
	"unicode/utf8"

	"filippo.io/age"
)

const Format = "routeweaver-backup"
const Version = 1
const MaxArchiveBytes = 16 << 20
const maxPlaintextBytes = store.MaxSnapshotBytes + 16384
const workFactor = 18 // age's recommended default, capped on untrusted decrypts.

var ErrInvalid = errors.New("backup cannot be authenticated or is incomplete; check the passphrase and file")
var ErrUnsupported = errors.New("unsupported backup format or database schema; use a compatible RouteWeaver version")
var ErrSize = errors.New("backup exceeds the 16 MiB archive limit")

// Manifest is inside the authenticated ciphertext, never a trusted sidecar.
type Manifest struct {
	Format          string    `json:"format"`
	Version         int       `json:"version"`
	SchemaVersion   int       `json:"schemaVersion"`
	CreatedAt       time.Time `json:"createdAt"`
	Records         int       `json:"records"`
	Identities      int       `json:"identities"`
	Tokens          int       `json:"tokens"`
	Counters        int       `json:"counters"`
	ContainsSecrets bool      `json:"containsSecrets"`
}
type envelope struct {
	Manifest Manifest       `json:"manifest"`
	Snapshot store.Snapshot `json:"snapshot"`
}
type Impact struct {
	Mode              string `json:"mode"`
	ReplacesLiveStore bool   `json:"replacesLiveStore"`
	IncludesSecrets   bool   `json:"includesSecrets"`
	RequiresRestart   bool   `json:"requiresRestart"`
}
type Summary struct {
	Manifest Manifest       `json:"manifest"`
	Digest   string         `json:"digest"`
	Counts   map[string]int `json:"counts"`
	Impact   Impact         `json:"impact"`
}

// Prepared can only be constructed by successful full authentication and schema
// validation. Its snapshot is intentionally not exported or JSON serializable.
type Prepared struct {
	snapshot store.Snapshot
	summary  Summary
	stream   *store.Store
	stageDir string
	stageKey []byte
	limits   Limits
}

func (p *Prepared) Summary() Summary {
	v := p.summary
	v.Counts = map[string]int{}
	for k, n := range p.summary.Counts {
		v.Counts[k] = n
	}
	return v
}
func (p *Prepared) Restore(ctx context.Context, target string, key []byte) error {
	if p.stream != nil {
		ctx, cancel := context.WithTimeout(ctx, p.limits.Duration)
		defer cancel()
		return store.RestoreBackupFresh(ctx, target, key, p.stream, p.limits.storeLimits())
	}
	return store.RestoreFresh(ctx, target, key, p.snapshot)
}

// Close removes encrypted preview staging. It is safe to call more than once.
func (p *Prepared) Close() error {
	if p.stream != nil {
		p.stream.Close()
		p.stream = nil
	}
	clear(p.stageKey)
	p.stageKey = nil
	if p.stageDir != "" {
		err := os.RemoveAll(p.stageDir)
		p.stageDir = ""
		return err
	}
	return nil
}

func ValidatePassword(password string) error {
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 12 || len(password) > 1024 {
		return errors.New("backup passphrase must contain at least 12 characters and at most 1024 bytes")
	}
	return nil
}
func Create(ctx context.Context, s *store.Store, password string) ([]byte, error) {
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	snapshot, err := s.ExportSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	v := envelope{Manifest: manifest(snapshot, time.Now().UTC()), Snapshot: snapshot}
	plain, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	if len(plain) > maxPlaintextBytes {
		return nil, ErrSize
	}
	recipient, err := age.NewScryptRecipient(password)
	if err != nil {
		return nil, ErrInvalid
	}
	recipient.SetWorkFactor(workFactor)
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	var dst bytes.Buffer
	w, err := age.Encrypt(&dst, recipient)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = w.Write(plain); err != nil {
		return nil, ErrInvalid
	}
	if err = w.Close(); err != nil {
		return nil, ErrInvalid
	}
	if dst.Len() > MaxArchiveBytes {
		return nil, ErrSize
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return dst.Bytes(), nil
}

// Preview consumes and authenticates the entire stream, including age's final
// chunk, before parsing or returning anything. Truncated valid JSON never passes.
func Preview(encrypted []byte, password string) (*Prepared, error) {
	if len(encrypted) > MaxArchiveBytes {
		return nil, ErrSize
	}
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	identity, err := age.NewScryptIdentity(password)
	if err != nil {
		return nil, ErrInvalid
	}
	identity.SetMaxWorkFactor(workFactor)
	r, err := age.Decrypt(bytes.NewReader(encrypted), identity)
	if err != nil {
		return nil, ErrInvalid
	}
	plain, err := io.ReadAll(io.LimitReader(r, maxPlaintextBytes+1))
	if err != nil {
		return nil, ErrInvalid
	}
	defer clear(plain)
	if len(plain) > maxPlaintextBytes {
		return nil, ErrSize
	}
	p, err := previewLegacyPlain(plain)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encrypted)
	p.summary.Digest = hex.EncodeToString(digest[:])
	return p, nil
}
func previewLegacyPlain(plain []byte) (*Prepared, error) {
	var err error
	var v envelope
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&v) != nil {
		return nil, ErrInvalid
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, ErrInvalid
	}
	if v.Manifest.Format != Format || v.Manifest.Version != Version || v.Manifest.SchemaVersion != store.BackupSchemaVersion || v.Snapshot.SchemaVersion != store.BackupSchemaVersion {
		return nil, ErrUnsupported
	}
	if v.Manifest.CreatedAt.IsZero() || v.Manifest != manifest(v.Snapshot, v.Manifest.CreatedAt) {
		return nil, ErrInvalid
	}
	if err = store.ValidateSnapshot(v.Snapshot); err != nil {
		return nil, ErrInvalid
	}
	counts := map[string]int{}
	for _, record := range v.Snapshot.Records {
		kind := record.Kind
		if strings.HasPrefix(kind, "tenant/") {
			parts := strings.Split(kind, "/")
			kind = parts[len(parts)-1]
		}
		counts[kind]++
	}
	return &Prepared{snapshot: v.Snapshot, summary: Summary{Manifest: v.Manifest, Counts: counts, Impact: Impact{Mode: "fresh-target", IncludesSecrets: true, RequiresRestart: true}}}, nil
}
func manifest(v store.Snapshot, created time.Time) Manifest {
	return Manifest{Format: Format, Version: Version, SchemaVersion: v.SchemaVersion, CreatedAt: created, Records: len(v.Records), Identities: len(v.Identities), Tokens: len(v.Tokens), Counters: len(v.Counters), ContainsSecrets: true}
}
