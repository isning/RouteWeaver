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
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"time"

	"filippo.io/age"
)

// SetVersion is an offline directory container, not a v2 stream or a schema
// migration version. No physical SQLite input is accepted by this API.
const SetVersion = 3
const setFormat = "routeweaver-backup-set"
const setManifestName = "manifest.age"
const maxSetManifest = 1 << 20

// SetLimits requires explicit finite whole-operation and workspace budgets.
// DiskBytes is an admission envelope, not a reservation of free filesystem space.
// Creation needs TotalBytes; restore needs at most 9*TotalBytes+128MiB for its
// owned encrypted staging/fresh databases and archive. Offline imports use
// MEMORY rollback journals and bounded main-file page counts, not growing WALs. The input
// archive is not deleted. SQLite independently enforces database page limits.
type SetLimits struct {
	TotalBytes  int64
	TotalRows   int
	PartBytes   int64
	PartRows    int
	RecordBytes int
	Parts       int
	Duration    time.Duration
	DiskBytes   int64
}

// Validate rejects omitted budgets and values outside the offline hard guards.
func (l SetLimits) Validate() error {
	if l.TotalBytes < 1 || l.TotalBytes > 32<<30 || l.TotalRows < 1 || l.TotalRows > 64000000 || l.PartBytes < 8192 || l.PartBytes > 1<<30 || l.PartRows < 1 || l.PartRows > 2000000 || l.RecordBytes < 1 || l.RecordBytes > 128<<20 || l.Parts < 1 || l.Parts > 256 || l.Duration <= 0 || l.Duration > 6*time.Hour || l.DiskBytes < 9*l.TotalBytes+(128<<20) {
		return errors.New("invalid offline backup-set limits or insufficient explicit disk envelope")
	}
	return nil
}
func (l SetLimits) storeLimits() store.OfflineBackupLimits {
	return store.OfflineBackupLimits{MaxBytes: l.TotalBytes, MaxRows: l.TotalRows, MaxRecordBytes: l.RecordBytes}
}

type setPart struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	Rows   int    `json:"rows"`
	SHA256 string `json:"sha256"`
}
type setManifest struct {
	Format        string    `json:"format"`
	Version       int       `json:"version"`
	SchemaVersion int       `json:"schemaVersion"`
	ID            string    `json:"id"`
	CreatedAt     string    `json:"createdAt"`
	Identity      string    `json:"identity"`
	Parts         []setPart `json:"parts"`
	Rows          int       `json:"rows"`
	SHA256        string    `json:"sha256"`
}
type setHeader struct {
	Format  string `json:"format"`
	Version int    `json:"version"`
	ID      string `json:"id"`
	Index   int    `json:"index"`
}
type setFooter struct {
	Rows   int    `json:"rows"`
	SHA256 string `json:"sha256"`
}
type setLine struct {
	Header *setHeader         `json:"header,omitempty"`
	Frame  *store.BackupFrame `json:"frame,omitempty"`
	Footer *setFooter         `json:"footer,omitempty"`
}

func partName(i int) string           { return fmt.Sprintf("part-%06d.age", i) }
func digest(h hash.Hash) string       { return hex.EncodeToString(h.Sum(nil)) }
func canonical(v any) ([]byte, error) { b, e := json.Marshal(v); return append(b, '\n'), e }
func parseCanonical(b []byte, v any) error {
	if e := strictJSON(b, v); e != nil {
		return e
	}
	check, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if !bytes.Equal(b, check) {
		return ErrInvalid
	}
	return nil
}

// CreateSet publishes only a complete, durable logical set into an absent path.
// The caller supplies a locked read-only source for offline operational use.
func CreateSet(ctx context.Context, s *store.Store, password, target string, l SetLimits) error {
	if s == nil {
		return errors.New("backup source required")
	}
	if e := l.Validate(); e != nil {
		return e
	}
	if e := ValidatePassword(password); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, l.Duration)
	defer cancel()
	if !filepath.IsAbs(target) {
		return errors.New("absolute fresh backup-set target required")
	}
	if e := s.ValidateBackupDestination(ctx, target); e != nil {
		return e
	}
	if _, e := os.Lstat(target); !os.IsNotExist(e) {
		return errors.New("backup-set target must be absent")
	}
	if e := checkSetFreeSpace(filepath.Dir(target), l.TotalBytes); e != nil {
		return e
	}
	dir, e := os.MkdirTemp(filepath.Dir(target), ".backup-set-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	identity, e := age.GenerateX25519Identity()
	if e != nil {
		return e
	}
	id := make([]byte, 32)
	if _, e = rand.Read(id); e != nil {
		return e
	}
	m := setManifest{Format: setFormat, Version: SetVersion, SchemaVersion: store.BackupSchemaVersion, ID: hex.EncodeToString(id), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Identity: identity.String()}
	global := sha256.New()
	var total int64
	var file *os.File
	var encrypted io.WriteCloser
	var cipherBound *boundedWriter
	var partHash hash.Hash
	var plainBytes int64
	var rows int
	closePart := func() error {
		if file == nil {
			return nil
		}
		footer, _ := canonical(setLine{Footer: &setFooter{Rows: rows, SHA256: digest(partHash)}})
		if _, e := encrypted.Write(footer); e != nil {
			return e
		}
		if e := encrypted.Close(); e != nil {
			return e
		}
		if e := file.Sync(); e != nil {
			return e
		}
		if e := file.Close(); e != nil {
			return e
		}
		n := cipherBound.n
		total += n
		if total > l.TotalBytes {
			return ErrStreamSize
		}
		// Hash only ciphertext from the completed, owned file. This is bounded I/O.
		f, e := os.Open(file.Name())
		if e != nil {
			return e
		}
		h := sha256.New()
		_, e = io.Copy(h, &boundedReader{ctx: ctx, r: f, max: n})
		ce := f.Close()
		if e != nil {
			return e
		}
		if ce != nil {
			return ce
		}
		m.Parts = append(m.Parts, setPart{Name: partName(len(m.Parts) + 1), Bytes: n, Rows: rows, SHA256: digest(h)})
		file = nil
		return nil
	}
	defer func() {
		if file != nil {
			file.Close()
		}
	}()
	openPart := func() error {
		if len(m.Parts) >= l.Parts {
			return errors.New("backup-set part budget exceeded")
		}
		var e error
		file, e = os.OpenFile(filepath.Join(dir, partName(len(m.Parts)+1)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		cipherBound = &boundedWriter{ctx: ctx, w: file, max: min(l.PartBytes, l.TotalBytes-total)}
		encrypted, e = age.Encrypt(cipherBound, identity.Recipient())
		if e != nil {
			return e
		}
		b, _ := canonical(setLine{Header: &setHeader{Format: setFormat, Version: SetVersion, ID: m.ID, Index: len(m.Parts) + 1}})
		if _, e = encrypted.Write(b); e != nil {
			return e
		}
		plainBytes = int64(len(b))
		rows = 0
		partHash = sha256.New()
		return nil
	}
	e = s.ExportBackupOffline(ctx, l.storeLimits(), func(f store.BackupFrame) error {
		b, e := canonical(setLine{Frame: &f})
		if e != nil {
			return e
		}
		defer clear(b)
		// Reserve both footer bytes and encryption expansion, not just frame data.
		allowance := l.PartBytes - l.PartBytes/100 - 4096
		if int64(len(b))+512 > allowance {
			return ErrBackupSetRecordSize
		}
		if file != nil && (rows >= l.PartRows || plainBytes+int64(len(b))+512 > allowance) {
			if e = closePart(); e != nil {
				return e
			}
		}
		if file == nil {
			if e = openPart(); e != nil {
				return e
			}
		}
		if _, e = encrypted.Write(b); e != nil {
			return e
		}
		plainBytes += int64(len(b))
		rows++
		m.Rows++
		c, e := canonical(f)
		if e != nil {
			return e
		}
		defer clear(c)
		partHash.Write(c)
		global.Write(c)
		return nil
	})
	if e != nil {
		return e
	}
	if e = closePart(); e != nil {
		return e
	}
	m.SHA256 = digest(global)
	b, e := canonical(m)
	if e != nil {
		return e
	}
	defer clear(b)
	if len(b) > maxSetManifest {
		return ErrStreamSize
	}
	recipient, e := age.NewScryptRecipient(password)
	if e != nil {
		return e
	}
	recipient.SetWorkFactor(workFactor)
	f, e := os.OpenFile(filepath.Join(dir, setManifestName), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	bound := &boundedWriter{ctx: ctx, w: f, max: min(int64(maxSetManifest), l.TotalBytes-total)}
	w, e := age.Encrypt(bound, recipient)
	if e == nil {
		_, e = w.Write(b)
	}
	if e == nil {
		e = w.Close()
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	e = d.Sync()
	d.Close()
	if e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	return publishSetDirectory(dir, target)
}

var ErrBackupSetRecordSize = errors.New("logical record cannot fit configured backup-set part; increase reviewed part bytes without exceeding record limit")

// RestoreSet accepts only authenticated logical parts, validates all rows in one
// transaction, and publishes a verified fresh encrypted database. It never
// replaces or activates a live database and never deletes the input set.
func RestoreSet(ctx context.Context, dir, password, target string, key []byte, l SetLimits) error {
	if e := l.Validate(); e != nil {
		return e
	}
	if e := ValidatePassword(password); e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, l.Duration)
	defer cancel()
	if !filepath.IsAbs(target) || len(key) != 32 {
		return errors.New("absolute fresh database target and 32-byte master key required")
	}
	input, e := filepath.Abs(dir)
	if e != nil {
		return e
	}
	input, e = filepath.EvalSymlinks(input)
	if e != nil {
		return e
	}
	output, e := store.CanonicalDatabasePath(target)
	if e != nil {
		return e
	}
	relative, e := filepath.Rel(input, filepath.Dir(output))
	if e != nil {
		return e
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return errors.New("restore target and workspace must be outside the input backup set")
	}
	target = output
	root, e := os.OpenRoot(input)
	if e != nil {
		return e
	}
	defer root.Close()
	mf, e := openSetFile(root, setManifestName)
	if e != nil {
		return e
	}
	defer mf.Close()
	mi, e := mf.Stat()
	if e != nil {
		return e
	}
	if mi.Size() > maxSetManifest || mi.Size() > l.TotalBytes {
		return ErrStreamSize
	}
	identity, e := age.NewScryptIdentity(password)
	if e != nil {
		return e
	}
	identity.SetMaxWorkFactor(workFactor)
	plain, e := age.Decrypt(&boundedReader{ctx: ctx, r: mf, max: maxSetManifest}, identity)
	if e != nil {
		return streamError(e)
	}
	b, e := io.ReadAll(&boundedReader{ctx: ctx, r: plain, max: maxSetManifest})
	if e != nil {
		return streamError(e)
	}
	defer clear(b)
	var m setManifest
	if len(b) == 0 || b[len(b)-1] != '\n' || parseCanonical(b[:len(b)-1], &m) != nil {
		return ErrInvalid
	}
	if m.Format != setFormat || m.Version != SetVersion || m.SchemaVersion != store.BackupSchemaVersion {
		return ErrUnsupported
	}
	id, e := hex.DecodeString(m.ID)
	if e != nil || len(id) != 32 {
		return ErrInvalid
	}
	if _, e = time.Parse(time.RFC3339Nano, m.CreatedAt); e != nil {
		return ErrInvalid
	}
	if len(m.Parts) < 1 || len(m.Parts) > l.Parts || m.Rows < 1 || m.Rows > l.TotalRows {
		return ErrStreamSize
	}
	if h, e := hex.DecodeString(m.SHA256); e != nil || len(h) != sha256.Size {
		return ErrInvalid
	}
	partIdentity, e := age.ParseX25519Identity(m.Identity)
	if e != nil {
		return ErrInvalid
	}
	total := mi.Size()
	rows := 0
	for i, p := range m.Parts {
		if p.Name != partName(i+1) || p.Bytes < 1 || p.Bytes > l.PartBytes || p.Rows < 1 || p.Rows > l.PartRows {
			return ErrInvalid
		}
		if h, e := hex.DecodeString(p.SHA256); e != nil || len(h) != sha256.Size {
			return ErrInvalid
		}
		total += p.Bytes
		rows += p.Rows
		if total > l.TotalBytes || rows > l.TotalRows {
			return ErrStreamSize
		}
	}
	if rows != m.Rows {
		return ErrInvalid
	}
	directory, e := root.Open(".")
	if e != nil {
		return e
	}
	entries, e := directory.ReadDir(l.Parts + 2)
	directory.Close()
	if e != nil && !errors.Is(e, io.EOF) {
		return e
	}
	if len(entries) != len(m.Parts)+1 {
		return ErrInvalid
	}
	wanted := map[string]bool{setManifestName: true}
	for _, p := range m.Parts {
		wanted[p.Name] = true
	}
	for _, entry := range entries {
		if !wanted[entry.Name()] || !entry.Type().IsRegular() {
			return ErrInvalid
		}
	}
	if !filepath.IsAbs(target) || len(key) != 32 {
		return errors.New("absolute fresh database target and 32-byte master key required")
	}
	if e := checkSetFreeSpace(filepath.Dir(target), 8*l.TotalBytes+(128<<20)); e != nil {
		return e
	}
	stageDir, e := os.MkdirTemp(filepath.Dir(target), ".backup-set-restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stageDir)
	stageKey := make([]byte, 32)
	if _, e = rand.Read(stageKey); e != nil {
		return e
	}
	defer clear(stageKey)
	stage, e := store.OpenOfflineBackupStage(filepath.Join(stageDir, "stage.db"), stageKey)
	if e != nil {
		return e
	}
	defer stage.Close()
	global := sha256.New()
	e = stage.ImportBackupOffline(ctx, l.storeLimits(), func(emit func(store.BackupFrame) error) error {
		for i, p := range m.Parts {
			if e := readSetPart(ctx, root, p, m.ID, i+1, partIdentity, l, global, emit); e != nil {
				return e
			}
		}
		if digest(global) != m.SHA256 {
			return ErrInvalid
		}
		return nil
	})
	if e != nil {
		return e
	}
	return store.RestoreBackupOfflineFresh(ctx, target, key, stage, l.storeLimits())
}
func openSetFile(root *os.Root, name string) (*os.File, error) {
	before, e := root.Lstat(name)
	if e != nil {
		return nil, e
	}
	if !before.Mode().IsRegular() {
		return nil, ErrInvalid
	}
	f, e := root.Open(name)
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	if e != nil || !os.SameFile(before, after) {
		f.Close()
		return nil, ErrInvalid
	}
	return f, nil
}
func readSetPart(ctx context.Context, root *os.Root, p setPart, id string, index int, identity age.Identity, l SetLimits, global hash.Hash, emit func(store.BackupFrame) error) error {
	f, e := openSetFile(root, p.Name)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	if info.Size() != p.Bytes {
		return ErrInvalid
	}
	cipherHash := sha256.New()
	bound := &boundedReader{ctx: ctx, r: io.TeeReader(f, cipherHash), max: p.Bytes}
	plain, e := age.Decrypt(bound, identity)
	if e != nil {
		return streamError(e)
	}
	scanner := bufio.NewScanner(&boundedReader{ctx: ctx, r: plain, max: l.PartBytes})
	scanner.Buffer(make([]byte, 4096), l.RecordBytes+(64<<10))
	if !scanner.Scan() {
		if e := scanner.Err(); e != nil {
			return streamError(e)
		}
		return ErrInvalid
	}
	var line setLine
	if parseCanonical(scanner.Bytes(), &line) != nil || line.Header == nil || line.Frame != nil || line.Footer != nil || *line.Header != (setHeader{Format: setFormat, Version: SetVersion, ID: id, Index: index}) {
		return ErrInvalid
	}
	h := sha256.New()
	rows := 0
	ended := false
	for scanner.Scan() {
		if e = ctx.Err(); e != nil {
			return e
		}
		line = setLine{}
		if parseCanonical(scanner.Bytes(), &line) != nil || line.Header != nil {
			return ErrInvalid
		}
		if line.Footer != nil {
			if line.Frame != nil || line.Footer.Rows != rows || line.Footer.SHA256 != digest(h) {
				return ErrInvalid
			}
			ended = true
			break
		}
		if line.Frame == nil {
			return ErrInvalid
		}
		rows++
		if rows > p.Rows {
			return ErrInvalid
		}
		b, e := canonical(*line.Frame)
		if e != nil {
			return e
		}
		h.Write(b)
		global.Write(b)
		clear(b)
		if e = emit(*line.Frame); e != nil {
			return e
		}
		if line.Frame.Record != nil {
			clear(line.Frame.Record.Data)
		}
	}
	// Scanning once more is necessary to authenticate the terminal age chunk and
	// reject appended plaintext/extra frames. Ciphertext digest also binds EOF.
	extra := scanner.Scan()
	if e := scanner.Err(); e != nil {
		return streamError(e)
	}
	if !ended || extra || rows != p.Rows || bound.n != p.Bytes || digest(cipherHash) != p.SHA256 {
		return ErrInvalid
	}
	return nil
}
