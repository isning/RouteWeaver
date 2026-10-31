package managedxray

import (
	"context"
	"sync"

	"github.com/xtls/xray-core/common"
	"github.com/xtls/xray-core/common/buf"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/transport"
	"github.com/xtls/xray-core/transport/pipe"
)

type managedDispatcher struct {
	inner   routing.Dispatcher
	runtime *Runtime
}

func (d *managedDispatcher) Type() interface{} { return routing.DispatcherType() }
func (d *managedDispatcher) Start() error      { return d.inner.Start() }
func (d *managedDispatcher) Close() error      { return d.inner.Close() }
func (d *managedDispatcher) Dispatch(ctx context.Context, dst xnet.Destination) (*transport.Link, error) {
	ctx, dst, err := ResolveDestination(ctx, dst, d.runtime.policy, d.runtime.resolver)
	if err != nil {
		return nil, d.runtime.reject()
	}
	if diagnosticCtx, ok := d.runtime.diagnosticContext(ctx); ok {
		return d.inner.Dispatch(diagnosticCtx, dst)
	}
	f, err := d.runtime.admit(ctx, false)
	if err != nil {
		// Xray's mux server treats a Dispatch error as carrier-fatal. A closed
		// logical link denies this stream without terminating already admitted
		// sibling streams. No outbound is dispatched and no bytes are admitted.
		reader, writer := pipe.New(pipe.WithSizeLimit(0))
		reader.Interrupt()
		return &transport.Link{Reader: reader, Writer: writer}, nil
	}
	l, err := d.inner.Dispatch(f.ctx, dst)
	if err != nil {
		f.close()
		return nil, err
	}
	// Client-facing link: writer is upload and reader is download.
	reader := &meterReader{inner: l.Reader, flow: f, upload: false}
	writer := &meterWriter{inner: l.Writer, flow: f, upload: true}
	f.install(l, reader.releasePending)
	return &transport.Link{Reader: reader, Writer: writer}, nil
}
func (d *managedDispatcher) DispatchLink(ctx context.Context, dst xnet.Destination, l *transport.Link) error {
	ctx, dst, err := ResolveDestination(ctx, dst, d.runtime.policy, d.runtime.resolver)
	if err != nil {
		return d.runtime.reject()
	}
	f, err := d.runtime.admit(ctx, true)
	if err != nil {
		return err
	}
	defer f.close()
	// Outbound-facing link: reader is upload and writer is download.
	reader := &meterReader{inner: l.Reader, flow: f, upload: true}
	f.install(l, reader.releasePending)
	return d.inner.DispatchLink(f.ctx, dst, &transport.Link{Reader: reader, Writer: &meterWriter{inner: l.Writer, flow: f, upload: false}})
}
func (f *flow) count(n int32, upload bool) {
	if upload {
		f.counter.upload.Add(uint64(n))
	} else {
		f.counter.download.Add(uint64(n))
	}
}

type meterReader struct {
	inner      buf.Reader
	flow       *flow
	upload     bool
	mu         sync.Mutex
	pending    buf.MultiBuffer
	pendingErr error
}

func (r *meterReader) ReadMultiBuffer() (out buf.MultiBuffer, err error) {
	r.mu.Lock()
	defer func() {
		r.mu.Unlock()
		if err != nil {
			r.flow.end(0)
		}
	}()
	if len(r.pending) == 0 {
		r.pending, r.pendingErr = r.inner.ReadMultiBuffer()
	}
	if len(r.pending) == 0 {
		return nil, r.pendingErr
	}
	rest, part := buf.SplitSize(r.pending, chunkSize)
	r.pending = rest
	if err = r.flow.bucket.WaitN(r.flow.ctx, int(part.Len())); err == nil {
		err = r.flow.ctx.Err()
	}
	if err != nil {
		buf.ReleaseMulti(part)
		buf.ReleaseMulti(r.pending)
		r.pending = nil
		return nil, err
	}
	r.flow.ioMu.RLock()
	n, reserveErr := r.flow.reserveBytes(part.Len())
	if reserveErr != nil {
		r.flow.ioMu.RUnlock()
		buf.ReleaseMulti(part)
		return nil, reserveErr
	}
	if n < part.Len() {
		left, allowed := buf.SplitSize(part, n)
		part = allowed
		r.pending = append(left, r.pending...)
	}
	r.flow.count(part.Len(), r.upload)
	r.flow.ioMu.RUnlock()
	if len(r.pending) == 0 {
		return part, r.pendingErr
	}
	return part, nil
}
func (r *meterReader) releasePending() {
	r.mu.Lock()
	buf.ReleaseMulti(r.pending)
	r.pending = nil
	r.mu.Unlock()
}
func (r *meterReader) Interrupt() { common.Interrupt(r.inner); r.releasePending(); r.flow.end(0) }
func (r *meterReader) Close() error {
	err := common.Close(r.inner)
	r.releasePending()
	r.flow.end(0)
	return err
}

type meterWriter struct {
	inner  buf.Writer
	flow   *flow
	upload bool
}

func (w *meterWriter) WriteMultiBuffer(mb buf.MultiBuffer) (err error) {
	defer func() {
		if err != nil {
			w.flow.end(1)
		}
	}()
	for len(mb) > 0 {
		rest, part := buf.SplitSize(mb, chunkSize)
		mb = rest
		if err = w.flow.bucket.WaitN(w.flow.ctx, int(part.Len())); err == nil {
			err = w.flow.ctx.Err()
		}
		if err != nil {
			buf.ReleaseMulti(part)
			buf.ReleaseMulti(mb)
			return err
		}
		// Measurement is payload admitted to the native link, not remote receipt.
		// Count before Write: upstream exposes no partial-write byte count on error.
		w.flow.ioMu.RLock()
		n, reserveErr := w.flow.reserveBytes(part.Len())
		if reserveErr != nil {
			w.flow.ioMu.RUnlock()
			buf.ReleaseMulti(part)
			buf.ReleaseMulti(mb)
			return reserveErr
		}
		if n < part.Len() {
			left, allowed := buf.SplitSize(part, n)
			part = allowed
			mb = append(left, mb...)
		}
		w.flow.count(part.Len(), w.upload)
		err = w.inner.WriteMultiBuffer(part)
		w.flow.ioMu.RUnlock()
		if err != nil {
			buf.ReleaseMulti(mb)
			return err
		}
	}
	return nil
}
func (w *meterWriter) Interrupt()   { common.Interrupt(w.inner); w.flow.end(1) }
func (w *meterWriter) Close() error { err := common.Close(w.inner); w.flow.end(1); return err }
