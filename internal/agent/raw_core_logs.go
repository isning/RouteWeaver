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

// RawCoreLogs only exists after explicit local sensitive-output opt-in.
// Raw bodies stay in bounded memory until delivery, never a plaintext spool.
type RawCoreLogs struct {
	mu               sync.Mutex
	flushMu          sync.Mutex
	closed           bool
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
	return &RawCoreLogs{scope: scope, now: time.Now, delivery: rawCoreLogSession{Scope: scope, Session: hex.EncodeToString(id[:])}}, nil
}
func (w *RawCoreLogs) Close() error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	w.queue = nil
	w.delivery.Pending = nil
	return nil
}
func rawCoreCount(n *uint32) {
	if *n < diagnostics.RawCoreCounterLimit {
		*n++
	}
}
func (w *RawCoreLogs) record(adapter, version, stream, line string, oversized bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if oversized {
		rawCoreCount(&w.dropped)
		return
	}
	if w.closed {
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
	return &rawCoreLineWriter{owner: w, adapter: adapter, version: version, stream: stream}
}

type rawCoreLineWriter struct {
	mu                       sync.Mutex
	owner                    *RawCoreLogs
	adapter, version, stream string
	line                     []byte
	oversized                bool
	second                   int64
	bytes                    int
}

func (b *rawCoreLineWriter) Write(p []byte) (int, error) {
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
		b.owner.record(b.adapter, b.version, b.stream, "", true)
		return n, nil
	}
	b.bytes += n
	for _, c := range p {
		if c == '\n' {
			b.owner.record(b.adapter, b.version, b.stream, string(b.line), b.oversized)
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
	if len(b.line) > 0 || b.oversized {
		b.owner.record(b.adapter, b.version, b.stream, string(b.line), b.oversized)
	}
	b.line = nil
	b.oversized = false
	return nil
}

func (w *RawCoreLogs) Flush(ctx context.Context, tr RawCoreLogTransport) error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	if w.closed || tr == nil {
		return errors.New("raw core logs closed or missing transport")
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
		r := diagnostics.RawCoreReport{Scope: w.scope, Session: w.delivery.Session, Sequence: w.delivery.Sequence + 1, Events: events, Omitted: w.omitted, Dropped: w.dropped}
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
		return e
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return errors.New("raw core log receipt mismatch")
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
		return receipt, e
	}
	if receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return receipt, errors.New("raw core log receipt mismatch")
	}
	return receipt, nil
}
