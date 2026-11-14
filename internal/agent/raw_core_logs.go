package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"sync"
	"time"
	"unicode/utf8"
)

var errInvalidRawCoreReceipt = errors.New("invalid raw core log receipt")

// RawCoreLogs only exists after explicit local sensitive-output opt-in.
// Raw bodies stay in bounded memory until delivery, never a plaintext spool.
type RawCoreLogs struct {
	mu               sync.Mutex
	flushMu          sync.Mutex
	closed           bool
	enabled          bool
	policyRevision   string
	writers          map[*rawCoreLineWriter]struct{}
	scope            Scope
	queue            []diagnostics.RawCoreEvent
	omitted, dropped uint32
	delivery         rawCoreLogSession
	pendingSince     time.Time
	now              func() time.Time
}
type rawCoreLogSession struct {
	Scope    Scope                      `json:"scope"`
	Session  string                     `json:"session"`
	Sequence uint64                     `json:"sequence,string"`
	Pending  *diagnostics.RawCoreReport `json:"pending,omitempty"`
}
type RawCoreLogTransport interface {
	RawCoreLogSettings(context.Context) (diagnostics.RawCoreSettings, error)
	ReportRawCoreLogs(context.Context, diagnostics.RawCoreReport) (diagnostics.RawCoreReceipt, error)
}

func OpenRawCoreLogs(scope Scope) (*RawCoreLogs, error) {
	if !domain.ValidID(scope.NodeID) || !domain.ValidID(scope.InstanceID) || !domain.ValidID(scope.EnrollmentEpoch) {
		return nil, diagnostics.ErrInvalid
	}
	var id [16]byte
	if _, e := rand.Read(id[:]); e != nil {
		return nil, e
	}
	return &RawCoreLogs{scope: scope, now: time.Now, writers: map[*rawCoreLineWriter]struct{}{}, delivery: rawCoreLogSession{Scope: scope, Session: hex.EncodeToString(id[:])}}, nil
}
func (w *RawCoreLogs) Close() error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	return w.applyPolicy("", false)
}

// applyPolicy is called under flushMu. Never take a writer lock while holding
// mu: a process writer can be concurrently finishing a line into record().
func (w *RawCoreLogs) applyPolicy(revision string, enabled bool) error {
	w.mu.Lock()
	if !w.closed && w.enabled == enabled && w.policyRevision == revision {
		w.mu.Unlock()
		return nil
	}
	w.enabled = false
	w.policyRevision = revision
	w.queue = nil
	w.omitted = 0
	w.dropped = 0
	writers := make([]*rawCoreLineWriter, 0, len(w.writers))
	for writer := range w.writers {
		writers = append(writers, writer)
	}
	w.mu.Unlock()
	w.delivery = rawCoreLogSession{Scope: w.scope}
	w.pendingSince = time.Time{}
	for _, writer := range writers {
		writer.mu.Lock()
		writer.line = nil
		writer.oversized = false
		writer.revision = ""
		writer.mu.Unlock()
	}
	if enabled {
		var id [16]byte
		if _, e := rand.Read(id[:]); e != nil {
			return e
		}
		w.delivery.Session = hex.EncodeToString(id[:])
		w.mu.Lock()
		w.enabled = !w.closed
		w.mu.Unlock()
	}
	return nil
}
func (w *RawCoreLogs) captureRevision() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.enabled || w.closed {
		return ""
	}
	return w.policyRevision
}
func validRawCoreSettings(v diagnostics.RawCoreSettings, instance string) bool {
	return v.InstanceID == instance && (v.RetentionSeconds == 3600 || v.RetentionSeconds == 86400 || v.RetentionSeconds == 604800) && v.HistoryLimit == 128 && v.LineBytesLimit == 4096 && (!v.Enabled || domain.ValidID(v.Revision)) && (v.Revision == "" || domain.ValidID(v.Revision))
}
func rawCoreCount(n *uint32) {
	if *n < diagnostics.RawCoreCounterLimit {
		*n++
	}
}
func (w *RawCoreLogs) record(adapter, version, stream, line string, oversized bool, revision string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || !w.enabled || revision == "" || revision != w.policyRevision {
		return
	}
	if oversized {
		rawCoreCount(&w.dropped)
		return
	}
	if !utf8.ValidString(line) {
		rawCoreCount(&w.dropped)
		return
	}
	if len(w.queue) >= 128 {
		rawCoreCount(&w.dropped)
		return
	}
	w.queue = append(w.queue, diagnostics.RawCoreEvent{AdapterID: adapter, Version: version, Stream: stream, Text: line, ObservedAt: w.now().UTC()})
}

// NewWriter captures only stdout/stderr of an owned supported-adapter process.
// No log file paths, arbitrary commands, network I/O or parser inference.
func (w *RawCoreLogs) NewWriter(adapter, version, stream string) io.WriteCloser {
	if w == nil || (adapter != "routeweaver/xray" && adapter != "routeweaver/sing-box" && adapter != ManagedXrayID) {
		return coreDiscard{}
	}
	writer := &rawCoreLineWriter{owner: w, adapter: adapter, version: version, stream: stream}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || len(w.writers) >= 16 {
		return coreDiscard{}
	}
	w.writers[writer] = struct{}{}
	return writer
}

type rawCoreLineWriter struct {
	mu                       sync.Mutex
	owner                    *RawCoreLogs
	adapter, version, stream string
	revision                 string
	closed                   bool
	line                     []byte
	oversized                bool
	second                   int64
	bytes                    int
}

func (b *rawCoreLineWriter) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if b.closed {
		return n, nil
	}
	revision := b.owner.captureRevision()
	if revision == "" {
		b.line = nil
		b.oversized = false
		b.revision = ""
		return n, nil
	}
	if revision != b.revision {
		b.line = nil
		b.oversized = false
		b.bytes = 0
		b.revision = revision
	}
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
		b.owner.record(b.adapter, b.version, b.stream, "", true, b.revision)
		return n, nil
	}
	b.bytes += n
	for _, c := range p {
		if c == '\n' {
			b.owner.record(b.adapter, b.version, b.stream, string(b.line), b.oversized, b.revision)
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
func (b *rawCoreLineWriter) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	b.closed = true
	if len(b.line) > 0 || b.oversized {
		b.owner.record(b.adapter, b.version, b.stream, string(b.line), b.oversized, b.revision)
	}
	b.line = nil
	b.oversized = false
	b.owner.mu.Lock()
	delete(b.owner.writers, b)
	b.owner.mu.Unlock()
	return nil
}

func (w *RawCoreLogs) Flush(ctx context.Context, tr RawCoreLogTransport) error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	if w.closed || tr == nil {
		return errors.New("raw core logs closed or missing transport")
	}
	settings, err := tr.RawCoreLogSettings(ctx)
	if err != nil {
		_ = w.applyPolicy("", false)
		return err
	}
	if !validRawCoreSettings(settings, w.scope.InstanceID) {
		_ = w.applyPolicy("", false)
		return errors.New("invalid raw core log settings")
	}
	if err = w.applyPolicy(settings.Revision, settings.Enabled); err != nil {
		return err
	}
	if !settings.Enabled {
		return nil
	}
	// A lost receipt may leave one immutable pending batch. After one hour,
	// forget it and start a fresh session rather than retain sensitive memory forever.
	if w.delivery.Pending != nil && w.now().Sub(w.pendingSince) >= diagnostics.RawCoreRetention {
		var id [16]byte
		if _, e := rand.Read(id[:]); e != nil {
			return e
		}
		w.delivery = rawCoreLogSession{Scope: w.scope, Session: hex.EncodeToString(id[:])}
	}
	if w.delivery.Pending == nil {
		if w.delivery.Sequence == ^uint64(0) {
			return errors.New("raw core log sequence exhausted")
		}
		w.mu.Lock()
		kept := make([]diagnostics.RawCoreEvent, 0, len(w.queue))
		for _, e := range w.queue {
			if e.ObservedAt.After(w.now().Add(-diagnostics.RawCoreRetention)) {
				kept = append(kept, e)
			} else {
				rawCoreCount(&w.dropped)
			}
		}
		w.queue = kept
		count := min(len(w.queue), diagnostics.RawCoreBatchLimit)
		events := append([]diagnostics.RawCoreEvent{}, w.queue[:count]...)
		w.queue = w.queue[count:]
		r := diagnostics.RawCoreReport{PolicyRevision: settings.Revision, Scope: w.scope, Session: w.delivery.Session, Sequence: w.delivery.Sequence + 1, Events: events, Omitted: w.omitted, Dropped: w.dropped}
		w.omitted = 0
		w.dropped = 0
		w.mu.Unlock()
		r.Digest = diagnostics.RawCoreReportDigest(r)
		w.delivery.Pending = &r
		w.pendingSince = w.now()
	}
	r := *w.delivery.Pending
	receipt, e := tr.ReportRawCoreLogs(ctx, r)
	if e != nil {
		var transportError *TransportError
		if errors.Is(e, errInvalidRawCoreReceipt) || errors.Is(e, diagnostics.ErrScope) || errors.As(e, &transportError) && (transportError.Status == 401 || transportError.Status == 403 || transportError.Status == 409) {
			_ = w.applyPolicy("", false)
		}
		return e
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		_ = w.applyPolicy("", false)
		return errInvalidRawCoreReceipt
	}
	next := rawCoreLogSession{Scope: w.scope, Session: w.delivery.Session, Sequence: r.Sequence}
	w.delivery = next
	return nil
}
func (w *RawCoreLogs) Run(ctx context.Context, tr RawCoreLogTransport, onError func(error)) {
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
func (t *HTTPTransport) ReportRawCoreLogs(ctx context.Context, r diagnostics.RawCoreReport) (diagnostics.RawCoreReceipt, error) {
	if r.Scope != t.scope {
		return diagnostics.RawCoreReceipt{}, diagnostics.ErrScope
	}
	b, _, e := t.request(ctx, http.MethodPost, t.endpoint("/core-logs"), r)
	if e != nil {
		return diagnostics.RawCoreReceipt{}, e
	}
	var receipt diagnostics.RawCoreReceipt
	if e = decodeWire(b, &receipt); e != nil {
		return receipt, errInvalidRawCoreReceipt
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return receipt, errInvalidRawCoreReceipt
	}
	return receipt, nil
}

func (t *HTTPTransport) RawCoreLogSettings(ctx context.Context) (diagnostics.RawCoreSettings, error) {
	var v diagnostics.RawCoreSettings
	b, _, e := t.request(ctx, http.MethodGet, t.endpoint("/core-logs/settings"), nil)
	if e != nil {
		return v, e
	}
	if e = decodeWire(b, &v); e != nil {
		return v, e
	}
	if !validRawCoreSettings(v, t.scope.InstanceID) {
		return v, errors.New("invalid raw core log settings")
	}
	return v, nil
}
