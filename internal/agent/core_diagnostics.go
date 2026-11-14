package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"sync"
	"time"
)

// CoreDiagnostics is explicitly local opt-in. Only classified fixed enums are
// buffered/persisted/transmitted. It is not a raw log collector. Capture writers
// never perform disk or network I/O and use bounded buffers and per-second work.
type CoreDiagnostics struct {
	mu               sync.Mutex
	flushMu          sync.Mutex
	root             string
	lock             *os.File
	scope            Scope
	queue            []diagnostics.CoreEvent
	omitted, dropped uint32
	disk             coreDiagnosticJournal
	now              func() time.Time
}
type coreDiagnosticJournal struct {
	Scope    Scope                   `json:"scope"`
	Sequence uint64                  `json:"sequence,string"`
	Pending  *diagnostics.CoreReport `json:"pending,omitempty"`
}
type CoreDiagnosticTransport interface {
	ReportCoreDiagnostics(context.Context, diagnostics.CoreReport) (diagnostics.CoreReceipt, error)
}

func OpenCoreDiagnostics(root string, scope Scope) (*CoreDiagnostics, error) {
	if root == "" || !domain.ValidID(scope.NodeID) || !domain.ValidID(scope.InstanceID) || !domain.ValidID(scope.EnrollmentEpoch) {
		return nil, diagnostics.ErrInvalid
	}
	if e := os.MkdirAll(root, 0700); e != nil {
		return nil, e
	}
	info, e := os.Lstat(root)
	if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("core diagnostic journal requires a private directory")
	}
	lock, e := lockRoot(root)
	if e != nil {
		return nil, e
	}
	w := &CoreDiagnostics{root: root, scope: scope, lock: lock, now: time.Now, disk: coreDiagnosticJournal{Scope: scope}}
	journalPath := filepath.Join(root, "core-diagnostics.json")
	if info, statErr := os.Lstat(journalPath); statErr == nil {
		if !info.Mode().IsRegular() || info.Size() > 32<<10 || info.Mode().Perm()&0077 != 0 {
			w.Close()
			return nil, errors.New("invalid core diagnostic journal file")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		w.Close()
		return nil, statErr
	}
	if e = readJSON(journalPath, &w.disk); e != nil && !errors.Is(e, os.ErrNotExist) {
		w.Close()
		return nil, e
	}
	if w.disk.Scope != scope {
		w.Close()
		return nil, diagnostics.ErrScope
	}
	if p := w.disk.Pending; p != nil {
		if p.Scope != scope || p.Sequence != w.disk.Sequence+1 || p.Validate(time.Now()) != nil {
			w.Close()
			return nil, errors.New("invalid core diagnostic journal")
		}
	}
	return w, nil
}
func (w *CoreDiagnostics) Close() error {
	if !w.flushMu.TryLock() {
		return errors.New("core diagnostic delivery has not quiesced")
	}
	defer w.flushMu.Unlock()
	if w.lock == nil {
		return nil
	}
	e := unlockRoot(w.lock)
	w.lock = nil
	return e
}
func coreCount(n *uint32) {
	if *n < diagnostics.CoreCounterLimit {
		*n++
	}
}
func (w *CoreDiagnostics) record(adapter, version, line string, oversized bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if oversized {
		coreCount(&w.dropped)
		return
	}
	code := diagnostics.ClassifyCoreLine(adapter, version, line)
	if code == "" {
		coreCount(&w.omitted)
		return
	}
	if len(w.queue) >= 128 {
		coreCount(&w.dropped)
		return
	}
	w.queue = append(w.queue, diagnostics.CoreEvent{AdapterID: adapter, Version: version, Code: code, ObservedAt: w.now().UTC()})
}

// NewWriter returns a sink for one process stream. Unsupported versions are
// discarded completely, rather than classified using a nearby core version.
func (w *CoreDiagnostics) NewWriter(adapter, version string) io.WriteCloser {
	if w == nil || !diagnostics.CoreSupported(adapter, version) {
		return coreDiscard{}
	}
	return &coreLineWriter{owner: w, adapter: adapter, version: version}
}

type coreDiscard struct{}

func (coreDiscard) Write(p []byte) (int, error) { return len(p), nil }
func (coreDiscard) Close() error                { return nil }

type coreLineWriter struct {
	mu               sync.Mutex
	owner            *CoreDiagnostics
	adapter, version string
	line             []byte
	oversized        bool
	second           int64
	bytes            int
}

func (b *coreLineWriter) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	second := b.owner.now().Unix()
	if second != b.second {
		b.second = second
		b.bytes = 0
	}
	// stdout/stderr drains cannot be held up by parsing an unbounded flood.
	// After the work budget, drop the fragment and discard to a later newline.
	if b.bytes+n > 64<<10 {
		b.line = nil
		b.oversized = true
		b.owner.record(b.adapter, b.version, "", true)
		return n, nil
	}
	b.bytes += n
	for _, c := range p {
		if c == '\n' {
			b.owner.record(b.adapter, b.version, string(b.line), b.oversized)
			b.line = nil
			b.oversized = false
			continue
		}
		if b.oversized {
			continue
		}
		if len(b.line) >= 4096 {
			b.line = nil
			b.oversized = true
			continue
		}
		b.line = append(b.line, c)
	}
	return n, nil
}
func (b *coreLineWriter) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.line) > 0 || b.oversized {
		b.owner.record(b.adapter, b.version, string(b.line), b.oversized)
	}
	b.line = nil
	b.oversized = false
	return nil
}

func (w *CoreDiagnostics) Flush(ctx context.Context, tr CoreDiagnosticTransport) error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	if w.lock == nil || tr == nil {
		return errors.New("core diagnostics closed or missing transport")
	}
	if w.disk.Pending == nil {
		if w.disk.Sequence == ^uint64(0) {
			return errors.New("core diagnostic sequence exhausted")
		}
		w.mu.Lock()
		count := min(len(w.queue), diagnostics.CoreBatchLimit)
		events := append([]diagnostics.CoreEvent{}, w.queue[:count]...)
		w.queue = w.queue[count:]
		r := diagnostics.CoreReport{Scope: w.scope, Sequence: w.disk.Sequence + 1, Events: events, Omitted: w.omitted, Dropped: w.dropped}
		w.omitted = 0
		w.dropped = 0
		w.mu.Unlock()
		r.Digest = diagnostics.CoreReportDigest(r)
		w.disk.Pending = &r
	}
	// Persist before sending; a failed ACK save safely replays the same digest.
	if e := writeJSON(filepath.Join(w.root, "core-diagnostics.json"), w.disk); e != nil {
		return errors.New("cannot persist core diagnostic batch")
	}
	r := *w.disk.Pending
	receipt, e := tr.ReportCoreDiagnostics(ctx, r)
	if e != nil {
		return e
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return errors.New("core diagnostic receipt mismatch")
	}
	next := coreDiagnosticJournal{Scope: w.scope, Sequence: r.Sequence}
	if e = writeJSON(filepath.Join(w.root, "core-diagnostics.json"), next); e != nil {
		return errors.New("cannot persist core diagnostic receipt")
	}
	w.disk = next
	return nil
}
func (w *CoreDiagnostics) Run(ctx context.Context, tr CoreDiagnosticTransport, onError func(error)) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		if e := w.Flush(ctx, tr); e != nil && ctx.Err() == nil && onError != nil {
			onError(e)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (t *HTTPTransport) ReportCoreDiagnostics(ctx context.Context, r diagnostics.CoreReport) (diagnostics.CoreReceipt, error) {
	if r.Scope != t.scope {
		return diagnostics.CoreReceipt{}, diagnostics.ErrScope
	}
	b, _, e := t.request(ctx, http.MethodPost, t.endpoint("/core-diagnostics"), r)
	if e != nil {
		return diagnostics.CoreReceipt{}, e
	}
	var receipt diagnostics.CoreReceipt
	if e = decodeWire(b, &receipt); e != nil {
		return receipt, e
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return receipt, errors.New("core diagnostic receipt mismatch")
	}
	return receipt, nil
}
