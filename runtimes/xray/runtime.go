package managedxray

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/common"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/transport"
	"golang.org/x/time/rate"
	"routeweaver/internal/entrypolicy"
	// Register native implementations, not a private copy of their logic.
	_ "github.com/xtls/xray-core/main/distro/all"
)

const chunkSize = 4096

type counter struct {
	epoch    string
	binding  entrypolicy.Binding
	upload   atomic.Uint64
	download atomic.Uint64
}
type Runtime struct {
	diagnostics *runtimeDiagnostics
	context     context.Context
	cancel      context.CancelFunc
	pending     sync.WaitGroup
	settlements sync.WaitGroup
	instance    *core.Instance
	admission   entrypolicy.Admission
	policy      entrypolicy.DestinationPolicy
	resolver    DestinationResolver
	epoch       string
	mu          sync.Mutex
	closed      bool
	revoked     map[string]bool
	bindings    map[string]entrypolicy.Binding
	flows       map[*flow]struct{}
	buckets     map[string]*rate.Limiter
	counters    map[string]*counter
	sequence    atomic.Uint64
	rejected    atomic.Uint64
	closeOnce   sync.Once
	closeErr    error
}

type Options struct {
	DestinationResolver       DestinationResolver
	DiagnosticLoopbackTargets map[string]string
}

// New validates all mappings before constructing the unchanged upstream core.
// The caller supplies authoritative admission, normally agent-owned inherited pipes.
// There is deliberately no fallback process-local "global IP" authority.
func New(native []byte, d entrypolicy.Descriptor, a entrypolicy.Admission) (*Runtime, error) {
	return NewWithOptions(native, d, a, Options{})
}
func NewWithOptions(native []byte, d entrypolicy.Descriptor, a entrypolicy.Admission, options Options) (*Runtime, error) {
	if a == nil {
		return nil, errors.New("authoritative admission service required")
	}
	c, err := build(native, d)
	if err != nil {
		return nil, err
	}
	epoch := make([]byte, 16)
	if _, err = rand.Read(epoch); err != nil {
		return nil, err
	}
	rctx, rcancel := context.WithCancel(context.Background())
	r := &Runtime{context: rctx, cancel: rcancel, admission: a, policy: entrypolicy.DestinationPolicy{AllowCIDRs: append([]string(nil), d.DestinationPolicy.AllowCIDRs...)}, resolver: options.DestinationResolver, epoch: hex.EncodeToString(epoch), revoked: map[string]bool{}, bindings: map[string]entrypolicy.Binding{}, flows: map[*flow]struct{}{}, buckets: map[string]*rate.Limiter{}, counters: map[string]*counter{}}
	for _, b := range d.Bindings {
		key := bindingKey(b.InboundTag, b.SubjectID)
		r.bindings[key] = b
		sum := sha256.Sum256([]byte(key))
		r.counters[key] = &counter{epoch: r.epoch + "-" + hex.EncodeToString(sum[:8]), binding: b}
	}
	found := false
	for i, app := range c.App {
		if app.Type == "xray.app.dispatcher.Config" {
			c.App[i] = serial.ToTypedMessage(&DispatcherConfig{})
			found = true
		}
	}
	if !found {
		rcancel()
		return nil, errors.New("native dispatcher is missing")
	}
	r.instance, err = core.NewWithContext(context.WithValue(rctx, runtimeContextKey{}, r), c)
	if err != nil {
		rcancel()
		return nil, err
	}
	r.initDiagnostics(native, d, options.DiagnosticLoopbackTargets)
	return r, nil
}
func bindingKey(tag, subject string) string { return tag + "\x00" + subject }
func (r *Runtime) Start() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("runtime closed")
	}
	return r.instance.Start()
}
func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.cancel()
		fs := r.flowListLocked("")
		r.mu.Unlock()
		for _, f := range fs {
			f.close()
		}
		r.closeErr = r.instance.Close()
		r.pending.Wait()
		r.settlements.Wait()
	})
	return r.closeErr
}
func (r *Runtime) flowListLocked(account string) []*flow {
	out := make([]*flow, 0, len(r.flows))
	for f := range r.flows {
		if account == "" || f.binding.AccountID == account {
			out = append(out, f)
		}
	}
	return out
}

// RevokeAccount is sticky for this runtime revision, applies before any I/O
// interruption, and cannot be undone by an outstanding or cached allow response.
func (r *Runtime) RevokeAccount(account string) {
	r.mu.Lock()
	r.revoked[account] = true
	fs := r.flowListLocked(account)
	r.mu.Unlock()
	for _, f := range fs {
		f.close()
	}
}
func (r *Runtime) Snapshot() entrypolicy.Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := entrypolicy.Snapshot{LedgerMode: "admission-budget", ObservedAt: time.Now().UTC(), AdapterID: AdapterID, RuntimeVersion: Version, CounterEpoch: r.epoch, ActiveFlows: len(r.flows), RejectedFlows: r.rejected.Load(), Counters: []entrypolicy.Counter{}}
	for _, c := range r.counters {
		up, down := c.upload.Load(), c.download.Load()
		s.Counters = append(s.Counters, entrypolicy.Counter{CounterEpoch: c.epoch, Binding: c.binding, MeasurementLayer: entrypolicy.MeasurementLayer, UploadBytes: up, DownloadBytes: down, CumulativeBytes: up + down})
	}
	sort.Slice(s.Counters, func(i, j int) bool {
		return bindingKey(s.Counters[i].InboundTag, s.Counters[i].SubjectID) < bindingKey(s.Counters[j].InboundTag, s.Counters[j].SubjectID)
	})
	return s
}
func (r *Runtime) reject() error {
	r.rejected.Add(1)
	return errors.New("managed entry admission denied")
}
func (r *Runtime) admit(ctx context.Context, direct bool) (*flow, error) {
	in := session.InboundFromContext(ctx)
	if in == nil || in.User == nil || in.Conn == nil {
		return nil, r.reject()
	}
	b, ok := r.bindings[bindingKey(in.Tag, in.User.Email)]
	if !ok {
		return nil, r.reject()
	}
	// Never trust mux's client-controlled Source override. Config validation also
	// excludes PROXY-protocol transports which could replace RemoteAddr.
	host, _, err := net.SplitHostPort(in.Conn.RemoteAddr().String())
	if err != nil {
		return nil, r.reject()
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return nil, r.reject()
	}
	ip = ip.Unmap()
	r.mu.Lock()
	denied := r.closed || r.revoked[b.AccountID]
	if !denied {
		r.pending.Add(1)
	}
	r.mu.Unlock()
	if denied {
		return nil, r.reject()
	}
	defer r.pending.Done()
	req := entrypolicy.AdmissionRequest{EntryID: b.EntryID, SubjectID: b.SubjectID, CredentialVersion: b.CredentialVersion, ClientIP: ip.String(), PresenceID: fmt.Sprintf("%s-%d", r.epoch, r.sequence.Add(1))}
	ask, cancel := context.WithTimeout(ctx, 2*time.Second)
	lease, err := r.admission.Acquire(ask, req)
	cancel()
	if err != nil || !lease.Allowed {
		return nil, r.reject()
	}
	ttl, err := validLease(lease, b)
	if err != nil {
		r.discardGrant(req, lease.LeaseID)
		return nil, r.reject()
	}
	// Plain VLESS already sets 3; copy metadata rather than racing other streams
	// of a mux carrier. Vision is rejected in native config before startup.
	metadata := *in
	metadata.CanSpliceCopy = 3
	ctx = session.ContextWithInbound(ctx, &metadata)
	fctx, fcancel := context.WithCancel(ctx)
	f := &flow{runtime: r, binding: b, request: req, ctx: fctx, cancel: fcancel, raw: in.Conn, direct: direct, counter: r.counters[bindingKey(b.InboundTag, b.SubjectID)], lease: lease, renewNow: make(chan struct{}, 1), budgetChanged: make(chan struct{})}
	r.mu.Lock()
	if r.closed || r.revoked[b.AccountID] || ctx.Err() != nil {
		r.mu.Unlock()
		fcancel()
		r.discardGrant(req, lease.LeaseID)
		return nil, r.reject()
	}
	key := b.AccountID + "\x00" + b.EntryID
	bucket := r.buckets[key]
	if bucket == nil {
		bucket = rate.NewLimiter(rate.Inf, chunkSize)
		r.buckets[key] = bucket
	}
	setRate(bucket, lease.EntryRateBPS)
	f.bucket = bucket
	r.flows[f] = struct{}{}
	r.mu.Unlock()
	f.setExpiry(ttl)
	context.AfterFunc(fctx, f.close)
	go f.renew()
	return f, nil
}
func validLease(l entrypolicy.Lease, b entrypolicy.Binding) (time.Duration, error) {
	ttl := time.Until(l.ExpiresAt)
	if !l.Allowed || l.LeaseID == "" || l.AccountID != b.AccountID || l.RouteID != b.RouteID || ttl <= 0 || ttl > entrypolicy.MaxLease || l.EntryRateBPS < 0 {
		return 0, errors.New("invalid authoritative lease")
	}
	return ttl, nil
}
func setRate(b *rate.Limiter, bps int64) {
	limit := rate.Inf
	if bps > 0 {
		limit = rate.Limit(bps)
	}
	if b.Limit() != limit {
		b.SetLimit(limit)
	}
}
func (r *Runtime) release(id string) {
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = r.admission.Release(ctx, id)
}

type flow struct {
	runtime       *Runtime
	binding       entrypolicy.Binding
	request       entrypolicy.AdmissionRequest
	ctx           context.Context
	cancel        context.CancelFunc
	raw           net.Conn
	direct        bool
	bucket        *rate.Limiter
	counter       *counter
	mu            sync.Mutex
	ioMu          sync.RWMutex
	admitted      uint64
	renewNow      chan struct{}
	budgetChanged chan struct{}
	link          *transport.Link
	cleanup       func()
	closed        bool
	ended         [2]bool
	lease         entrypolicy.Lease
	deadline      time.Time
	timer         *time.Timer
	generation    uint64
	once          sync.Once
}

func (f *flow) setExpiry(ttl time.Duration) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false
	}
	if !f.deadline.IsZero() && !time.Now().Before(f.deadline) {
		return false
	}
	f.deadline = time.Now().Add(ttl)
	f.generation++
	gen := f.generation
	if f.timer != nil {
		f.timer.Stop()
	}
	f.timer = time.AfterFunc(ttl, func() {
		f.mu.Lock()
		expired := f.generation == gen
		f.mu.Unlock()
		if expired {
			f.close()
		}
	})
	return true
}
func (f *flow) install(l *transport.Link, cleanup func()) {
	f.mu.Lock()
	f.link = l
	f.cleanup = cleanup
	closed := f.closed
	f.mu.Unlock()
	if closed {
		f.killIO()
	}
}
func (f *flow) killIO() {
	f.mu.Lock()
	l, cleanup := f.link, f.cleanup
	f.mu.Unlock()
	if f.direct && f.raw != nil {
		_ = f.raw.Close()
	}
	if l != nil {
		common.Interrupt(l.Reader)
		common.Interrupt(l.Writer)
	}
	if cleanup != nil {
		cleanup()
	}
}
func (f *flow) close() {
	f.once.Do(func() {
		f.cancel()
		f.mu.Lock()
		f.closed = true
		if f.timer != nil {
			f.timer.Stop()
		}
		id := f.lease.LeaseID
		f.mu.Unlock()
		f.killIO()
		f.ioMu.Lock()
		f.ioMu.Unlock()
		f.runtime.settlements.Add(1)
		f.runtime.mu.Lock()
		delete(f.runtime.flows, f)
		f.runtime.mu.Unlock()
		go func() { defer f.runtime.settlements.Done(); f.settleAndRelease(id) }()
	})
}
func (f *flow) end(side int) {
	f.mu.Lock()
	f.ended[side] = true
	done := f.ended[0] && f.ended[1]
	f.mu.Unlock()
	if done {
		f.close()
	}
}
func (f *flow) renew() {
	for {
		f.mu.Lock()
		left := time.Until(f.deadline)
		f.mu.Unlock()
		delay := min(entrypolicy.RenewInterval, left/2)
		if delay <= 0 {
			f.close()
			return
		}
		timer := time.NewTimer(delay)
		select {
		case <-f.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-f.renewNow:
			timer.Stop()
		}
		ask, cancel := context.WithTimeout(f.ctx, min(2*time.Second, left))
		f.mu.Lock()
		request := f.request
		request.AdmittedBytes = f.admitted
		f.mu.Unlock()
		lease, err := f.runtime.admission.Acquire(ask, request)
		cancel()
		if f.ctx.Err() != nil {
			if err == nil && lease.Allowed {
				f.runtime.release(lease.LeaseID)
			}
			return
		}
		if err != nil {
			select {
			case <-f.ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			continue
		} // Independent expiry still runs while the service is unavailable.
		if !lease.Allowed {
			f.close()
			return
		}
		ttl, err := validLease(lease, f.binding)
		if err != nil {
			f.close()
			return
		}
		f.mu.Lock()
		same := lease.LeaseID == f.lease.LeaseID
		budgetValid := lease.ByteBudget == nil || (*lease.ByteBudget > f.admitted && (f.lease.ByteBudget == nil || *lease.ByteBudget >= *f.lease.ByteBudget))
		if same && budgetValid {
			f.lease = lease
			close(f.budgetChanged)
			f.budgetChanged = make(chan struct{})
		}
		f.mu.Unlock()
		if !same || !budgetValid {
			f.runtime.release(lease.LeaseID)
			f.close()
			return
		}
		if !f.setExpiry(ttl) {
			f.close()
			return
		}
		f.runtime.mu.Lock()
		setRate(f.bucket, lease.EntryRateBPS)
		f.runtime.mu.Unlock()
	}
}

// reserveBytes is the payload gate, shared by both directions of one presence.
// Absolute ceilings are supplied by CP reservations across all account entries.
func (f *flow) reserveBytes(maximum int32) (int32, error) {
	for {
		f.mu.Lock()
		if f.closed || f.ctx.Err() != nil {
			f.mu.Unlock()
			return 0, context.Canceled
		}
		n := uint64(maximum)
		if f.lease.ByteBudget != nil {
			left := *f.lease.ByteBudget - f.admitted
			if left < n {
				n = left
			}
			if n == 0 {
				ch := f.budgetChanged
				f.mu.Unlock()
				select {
				case f.renewNow <- struct{}{}:
				default:
				}
				select {
				case <-f.ctx.Done():
					return 0, f.ctx.Err()
				case <-ch:
				}
				continue
			}
		}
		f.admitted += n
		low := f.lease.ByteBudget != nil && *f.lease.ByteBudget-f.admitted <= 4*chunkSize
		f.mu.Unlock()
		if low {
			select {
			case f.renewNow <- struct{}{}:
			default:
			}
		}
		return int32(n), nil
	}
}
func (f *flow) settleAndRelease(id string) {
	f.mu.Lock()
	request := f.request
	request.AdmittedBytes = f.admitted
	request.Final = true
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	_, _ = f.runtime.admission.Acquire(ctx, request)
	cancel()
	// CP keeps unresolved byte reservations on release/expiry; only the live IP
	// presence is released here. Final settlement retries require explicit evidence.
	f.runtime.release(id)
}

func (r *Runtime) discardGrant(request entrypolicy.AdmissionRequest, id string) {
	request.Final = true
	request.AdmittedBytes = 0
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	_, _ = r.admission.Acquire(ctx, request)
	cancel()
	r.release(id)
}
