package backup

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"time"

	"filippo.io/age"
)

const StreamVersion = 2
const MaxStreamBytes int64 = 1 << 30
const MaxStreamRows = 2000000
const MaxStreamRecordBytes = 128 << 20
const MaxStreamDuration = 10 * time.Minute
const maxCategories = 4096

var ErrStreamSize = errors.New("backup exceeds the configured archive, record, row or category limit; no history was omitted")

// Limits are resource ceilings, not an unlimited-capacity promise. Zero values
// select defaults; deployments may reduce ceilings or increase the record bound
// up to the reviewed hard ceiling. KDF work/concurrency are bounded separately.
type Limits struct {
	ArchiveBytes int64
	RecordBytes  int
	Rows         int
	Duration     time.Duration
}

func DefaultLimits() Limits {
	return Limits{MaxStreamBytes, 32 << 20, MaxStreamRows, MaxStreamDuration}
}
func (l Limits) Normalize() (Limits, error) {
	d := DefaultLimits()
	if l.ArchiveBytes == 0 {
		l.ArchiveBytes = d.ArchiveBytes
	}
	if l.RecordBytes == 0 {
		l.RecordBytes = d.RecordBytes
	}
	if l.Rows == 0 {
		l.Rows = d.Rows
	}
	if l.Duration == 0 {
		l.Duration = d.Duration
	}
	if l.ArchiveBytes < 1 || l.ArchiveBytes > MaxStreamBytes || l.RecordBytes < 1 || l.RecordBytes > MaxStreamRecordBytes || l.Rows < 1 || l.Rows > MaxStreamRows || l.Duration < time.Millisecond || l.Duration > MaxStreamDuration {
		return l, errors.New("invalid backup resource limits")
	}
	return l, nil
}
func (l Limits) storeLimits() store.BackupLimits {
	return store.BackupLimits{MaxBytes: l.ArchiveBytes, MaxRows: l.Rows, MaxRecordBytes: l.RecordBytes}
}

type streamHeader struct {
	Manifest Manifest `json:"manifest"`
}
type streamLine struct {
	*store.BackupFrame
	End *Manifest `json:"end,omitempty"`
}

// CreateStream emits age ciphertext incrementally. On error callers MUST discard
// the entire output: an incomplete ciphertext is deliberately not finalized.
func CreateStream(ctx context.Context, s *store.Store, password string, dst io.Writer, l Limits) error {
	if err := ValidatePassword(password); err != nil {
		return err
	}
	var err error
	l, err = l.Normalize()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, l.Duration)
	defer cancel()
	recipient, err := age.NewScryptRecipient(password)
	if err != nil {
		return ErrInvalid
	}
	recipient.SetWorkFactor(workFactor)
	encrypted := &boundedWriter{ctx: ctx, w: dst, max: l.ArchiveBytes}
	w, err := age.Encrypt(encrypted, recipient)
	if err != nil {
		return err
	}
	plain := &boundedWriter{ctx: ctx, w: w, max: l.ArchiveBytes}
	m := Manifest{Format: Format, Version: StreamVersion, SchemaVersion: store.BackupSchemaVersion, CreatedAt: time.Now().UTC(), ContainsSecrets: true}
	if err = writeLine(plain, streamHeader{m}, l); err != nil {
		return err
	}
	counts := map[string]int{}
	err = s.ExportBackup(ctx, l.storeLimits(), func(f store.BackupFrame) error {
		if err := addFrame(&m, counts, f); err != nil {
			return err
		}
		return writeLine(plain, f, l)
	})
	if err != nil {
		return err
	}
	if err = writeLine(plain, streamLine{End: &m}, l); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return w.Close()
}

// PreviewStream incrementally authenticates and parses v2, re-encrypting each
// logical record into a private ephemeral store. It returns only after terminal
// manifest, entire age EOF, relational validation, and transaction commit. Close
// the result to remove encrypted scratch files and discard its ephemeral key.
// V1 remains accepted under its original 16 MiB/100k-row limits.
func PreviewStream(ctx context.Context, src io.Reader, password string, l Limits) (prepared *Prepared, err error) {
	if err = ValidatePassword(password); err != nil {
		return nil, err
	}
	l, err = l.Normalize()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, l.Duration)
	defer cancel()
	hash := sha256.New()
	encrypted := &boundedReader{ctx: ctx, r: src, max: l.ArchiveBytes}
	identity, err := age.NewScryptIdentity(password)
	if err != nil {
		return nil, ErrInvalid
	}
	identity.SetMaxWorkFactor(workFactor)
	r, err := age.Decrypt(io.TeeReader(encrypted, hash), identity)
	if err != nil {
		return nil, streamError(err)
	}
	plain := &boundedReader{ctx: ctx, r: r, max: l.ArchiveBytes}
	scanner := bufio.NewScanner(plain)
	scanner.Buffer(make([]byte, 64<<10), l.RecordBytes+(64<<10))
	if !scanner.Scan() {
		return nil, streamError(scanner.Err())
	}
	first := scanner.Bytes()
	// Exported v1 envelopes are one line; also preserve the whitespace-flexible
	// JSON accepted by the original importer.
	var version struct {
		Manifest struct {
			Version int `json:"version"`
		} `json:"manifest"`
	}
	if json.Unmarshal(first, &version) != nil || version.Manifest.Version == Version {
		if len(first) > maxPlaintextBytes || encrypted.n > MaxArchiveBytes {
			return nil, ErrSize
		}
		// Authenticate EOF before parsing legacy fields. No data has touched disk.
		legacy := append([]byte{}, first...)
		defer func() { clear(legacy) }()
		for scanner.Scan() {
			if len(legacy)+len(scanner.Bytes())+1 > maxPlaintextBytes {
				return nil, ErrSize
			}
			legacy = append(legacy, '\n')
			legacy = append(legacy, scanner.Bytes()...)
		}
		if scanner.Err() != nil {
			return nil, streamError(scanner.Err())
		}
		if encrypted.n > MaxArchiveBytes {
			return nil, ErrSize
		}
		p, e := previewLegacyPlain(legacy)
		if e != nil {
			return nil, e
		}
		if len(p.snapshot.Records)+len(p.snapshot.Identities)+len(p.snapshot.Tokens)+len(p.snapshot.Counters)+len(p.snapshot.Migrations) > l.Rows || len(p.summary.Counts) > maxCategories {
			return nil, ErrStreamSize
		}
		for _, record := range p.snapshot.Records {
			if len(record.Data) > l.RecordBytes {
				return nil, ErrStreamSize
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		p.summary.Digest = hex.EncodeToString(hash.Sum(nil))
		return p, nil
	}
	var header streamHeader
	if strictJSON(first, &header) != nil {
		return nil, ErrInvalid
	}
	m := header.Manifest
	if m.Format != Format || m.Version != StreamVersion || m.SchemaVersion != store.BackupSchemaVersion {
		return nil, ErrUnsupported
	}
	if m.CreatedAt.IsZero() || !m.ContainsSecrets || m.Records != 0 || m.Identities != 0 || m.Tokens != 0 || m.Counters != 0 {
		return nil, ErrInvalid
	}
	dir, err := os.MkdirTemp("", "routeweaver-backup-")
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	stage, err := store.Open(filepath.Join(dir, "stage.db"), key)
	if err != nil {
		clear(key)
		os.RemoveAll(dir)
		return nil, err
	}
	p := &Prepared{stream: stage, stageDir: dir, stageKey: key, limits: l}
	success := false
	defer func() {
		if !success {
			p.Close()
		}
	}()
	counts := map[string]int{}
	err = stage.ImportBackup(ctx, l.storeLimits(), func(emit func(store.BackupFrame) error) error {
		for scanner.Scan() {
			var line streamLine
			// Explicit non-nil embedded frame lets encoding/json decode frame fields.
			line.BackupFrame = &store.BackupFrame{}
			if strictJSON(scanner.Bytes(), &line) != nil {
				return ErrInvalid
			}
			if line.End != nil {
				if *line.BackupFrame != (store.BackupFrame{}) || *line.End != m {
					return ErrInvalid
				}
				if scanner.Scan() {
					return ErrInvalid
				}
				if e := scanner.Err(); e != nil {
					return streamError(e)
				}
				return nil
			}
			if err := addFrame(&m, counts, *line.BackupFrame); err != nil {
				return err
			}
			if err := emit(*line.BackupFrame); err != nil {
				return ErrInvalid
			}
		}
		return streamError(scanner.Err()) // EOF without a terminal manifest is invalid.
	})
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	p.summary = Summary{Manifest: m, Digest: hex.EncodeToString(hash.Sum(nil)), Counts: counts, Impact: Impact{Mode: "fresh-target", IncludesSecrets: true, RequiresRestart: true}}
	success = true
	return p, nil
}
func addFrame(m *Manifest, counts map[string]int, f store.BackupFrame) error {
	switch {
	case f.Record != nil:
		m.Records++
		kind := f.Record.Kind
		if strings.HasPrefix(kind, "tenant/") {
			parts := strings.Split(kind, "/")
			kind = parts[len(parts)-1]
		}
		counts[kind]++
		if len(counts) > maxCategories {
			return ErrStreamSize
		}
	case f.Identity != nil:
		m.Identities++
	case f.Token != nil:
		m.Tokens++
	case f.Counter != nil:
		m.Counters++
	}
	return nil
}
func writeLine(w io.Writer, v any, l Limits) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	defer clear(b)
	if len(b) > l.RecordBytes+(32<<10) {
		return ErrStreamSize
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}
func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return ErrInvalid
	}
	return nil
}
func streamError(err error) error {
	if errors.Is(err, ErrStreamSize) {
		return ErrStreamSize
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return ErrInvalid
}

type boundedReader struct {
	ctx    context.Context
	r      io.Reader
	max, n int64
}

func (r *boundedReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	if r.n > r.max {
		return 0, ErrStreamSize
	}
	remaining := r.max - r.n
	if int64(len(p)) > remaining+1 {
		p = p[:remaining+1]
	}
	n, e := r.r.Read(p)
	r.n += int64(n)
	if r.n > r.max {
		return n, ErrStreamSize
	}
	return n, e
}

type boundedWriter struct {
	ctx    context.Context
	w      io.Writer
	max, n int64
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if e := w.ctx.Err(); e != nil {
		return 0, e
	}
	if int64(len(p)) > w.max-w.n {
		return 0, ErrStreamSize
	}
	n, e := w.w.Write(p)
	w.n += int64(n)
	return n, e
}
