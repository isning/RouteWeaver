package managedxray

import (
	"context"
	"encoding/json"
	"errors"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"net"
	"routeweaver/internal/diagnosticexec"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/entrypolicy"
	"sync"
	"time"
)

type diagnosticContextKey struct{}
type diagnosticAccess struct {
	runtime                 *Runtime
	route, entry, connector string
}
type diagnosticRoute struct{ entry, connector string }
type diagnosticOutcome struct {
	digest  string
	expires time.Time
	result  diagnostics.Result
}
type runtimeDiagnostics struct {
	mu                       sync.Mutex
	routes                   map[string]diagnosticRoute
	executor                 *diagnosticexec.Executor
	activeJob, activeAttempt string
	cancel                   context.CancelFunc
	completed                map[string]diagnosticOutcome
}

// Only the renderer's unique, unconditional principal rules before generic
// routing rules define a diagnostic connector. Ambiguity disables that route;
// it never selects the first default/loosely matching native rule.
func diagnosticRouteMap(native []byte, d entrypolicy.Descriptor) map[string]diagnosticRoute {
	var raw struct {
		Outbounds []struct {
			Tag string `json:"tag"`
		} `json:"outbounds"`
		Routing struct {
			Rules []json.RawMessage `json:"rules"`
		} `json:"routing"`
	}
	if json.Unmarshal(native, &raw) != nil {
		return nil
	}
	tags := map[string]bool{}
	for _, o := range raw.Outbounds {
		if tags[o.Tag] {
			return nil
		}
		tags[o.Tag] = true
	}
	subjects := map[string]string{}
	badSubject := map[string]bool{}
	for _, rule := range raw.Routing.Rules {
		var fields map[string]json.RawMessage
		if json.Unmarshal(rule, &fields) != nil {
			break
		}
		if len(fields) != 4 || fields["type"] == nil || fields["inboundTag"] == nil || fields["user"] == nil || fields["outboundTag"] == nil {
			break
		}
		var q struct {
			Type     string   `json:"type"`
			Inbounds []string `json:"inboundTag"`
			Users    []string `json:"user"`
			Outbound string   `json:"outboundTag"`
		}
		if json.Unmarshal(rule, &q) != nil || q.Type != "field" || len(q.Inbounds) != 1 || len(q.Users) != 1 || !tags[q.Outbound] {
			break
		}
		key := bindingKey(q.Inbounds[0], q.Users[0])
		if _, ok := subjects[key]; ok {
			badSubject[key] = true
		}
		subjects[key] = q.Outbound
	}
	out := map[string]diagnosticRoute{}
	badRoute := map[string]bool{}
	for _, b := range d.Bindings {
		key := bindingKey(b.InboundTag, b.SubjectID)
		tag, ok := subjects[key]
		if !ok || badSubject[key] {
			badRoute[b.RouteID] = true
			continue
		}
		route := diagnosticRoute{b.EntryID, tag}
		if old, ok := out[b.RouteID]; ok && old != route {
			badRoute[b.RouteID] = true
		}
		out[b.RouteID] = route
	}
	for id := range badRoute {
		delete(out, id)
	}
	return out
}
func (r *Runtime) initDiagnostics(native []byte, d entrypolicy.Descriptor, fixtures map[string]string) {
	state := &runtimeDiagnostics{routes: diagnosticRouteMap(native, d), completed: map[string]diagnosticOutcome{}}
	state.executor = diagnosticexec.New(diagnosticexec.Options{LoopbackTargets: fixtures, RouteDialer: func(ctx context.Context, p diagnostics.ManagedPath, network, address string) (net.Conn, error) {
		route, ok := state.routes[p.RouteID]
		if !ok || route.entry != p.EntryEndpointID || route.connector != p.ConnectorID || network != "tcp" {
			return nil, errors.New("diagnostic route is not the exact configured connector")
		}
		dst, err := xnet.ParseDestination("tcp:" + address)
		if err != nil {
			return nil, errors.New("invalid pinned diagnostic destination")
		}
		access := diagnosticAccess{r, p.RouteID, p.EntryEndpointID, p.ConnectorID}
		conn, err := core.Dial(context.WithValue(ctx, diagnosticContextKey{}, access), r.instance, dst)
		if err != nil {
			return nil, err
		}
		stop := context.AfterFunc(ctx, func() { conn.Close() })
		return &diagnosticConn{Conn: conn, stop: stop}, nil
	}})
	r.diagnostics = state
}

type diagnosticConn struct {
	net.Conn
	stop func() bool
}

func (c *diagnosticConn) Close() error { c.stop(); return c.Conn.Close() }
func (r *Runtime) RunDiagnostic(ctx context.Context, j diagnostics.Job) (diagnostics.Result, error) {
	if j.Validate(j.Scope) != nil || j.PathMode != "managed_route" || j.ManagedPath == nil || j.Status != "running" {
		return diagnostics.Result{}, diagnostics.ErrNotStarted
	}
	p := j.ManagedPath
	s := r.diagnostics
	s.mu.Lock()
	route, ok := s.routes[p.RouteID]
	if !ok || route.entry != p.EntryEndpointID || route.connector != p.ConnectorID {
		s.mu.Unlock()
		return diagnostics.Result{}, diagnostics.ErrNotStarted
	}
	key := j.ID + "/" + j.AttemptID
	digest := diagnostics.Digest(j)
	now := time.Now()
	for id, old := range s.completed {
		if !now.Before(old.expires) {
			delete(s.completed, id)
		}
	}
	if old, ok := s.completed[key]; ok {
		s.mu.Unlock()
		if old.digest != digest {
			return diagnostics.Result{}, diagnostics.ErrNotStarted
		}
		return old.result, nil
	}
	if s.cancel != nil || len(s.completed) >= 64 {
		s.mu.Unlock()
		return diagnostics.Result{}, diagnostics.ErrNotStarted
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		s.mu.Unlock()
		return diagnostics.Result{}, diagnostics.ErrNotStarted
	}
	r.pending.Add(1)
	r.mu.Unlock()
	defer r.pending.Done()
	runCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.context, cancel)
	defer stop()
	defer cancel()
	s.activeJob, s.activeAttempt, s.cancel = j.ID, j.AttemptID, cancel
	s.mu.Unlock()
	result := s.executor.Execute(runCtx, j)
	s.mu.Lock()
	s.completed[key] = diagnosticOutcome{digest, j.ExpiresAt, result}
	s.activeJob, s.activeAttempt, s.cancel = "", "", nil
	s.mu.Unlock()
	return result, nil
}
func (r *Runtime) CancelDiagnostic(job, attempt string) error {
	s := r.diagnostics
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel == nil {
		return nil
	}
	if s.activeJob != job || s.activeAttempt != attempt {
		return errors.New("diagnostic cancellation scope mismatch")
	}
	s.cancel()
	return nil
}
func (r *Runtime) diagnosticContext(ctx context.Context) (context.Context, bool) {
	access, ok := ctx.Value(diagnosticContextKey{}).(diagnosticAccess)
	if !ok || access.runtime != r {
		return ctx, false
	}
	route, ok := r.diagnostics.routes[access.route]
	if !ok || route.entry != access.entry || route.connector != access.connector {
		return ctx, false
	}
	return session.SetForcedOutboundTagToContext(ctx, access.connector), true
}
