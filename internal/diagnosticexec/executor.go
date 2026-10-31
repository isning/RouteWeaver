// Package diagnosticexec adapts bounded diagnostic intent to HTTP traffic.
package diagnosticexec

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/resources"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Options are local operator configuration, never job fields.
// LoopbackTargets maps exact target IDs to exact literal loopback fixture URLs.
// Production public targets must pass the same DNS pinning as resource imports.
type Options struct {
	LoopbackTargets map[string]string
	RouteDialer     func(context.Context, diagnostics.ManagedPath, string, string) (net.Conn, error)
}
type Executor struct {
	loopback    map[string]string
	slot        chan struct{}
	routeDialer func(context.Context, diagnostics.ManagedPath, string, string) (net.Conn, error)
}

func New(o Options) *Executor {
	e := &Executor{loopback: map[string]string{}, slot: make(chan struct{}, 1), routeDialer: o.RouteDialer}
	for k, v := range o.LoopbackTargets {
		e.loopback[k] = v
	}
	return e
}
func (e *Executor) Execute(parent context.Context, j diagnostics.Job) (out diagnostics.Result) {
	start := time.Now().UTC()
	out = diagnostics.Result{StartedAt: start, CostKnown: true, Status: "not_run", Phase: "authorization", Code: "invalid_job", Action: "Create a new bounded diagnostic for the current enrollment."}
	defer func() {
		out.FinishedAt = time.Now().UTC()
		out.DurationMS = out.FinishedAt.Sub(start).Milliseconds()
		if out.Status == "succeeded" && j.Kind != "connectivity" {
			payload := out.BytesReceived
			if j.Kind == "upload" {
				payload = out.BytesSent
			}
			rate := float64(payload) / out.FinishedAt.Sub(start).Seconds()
			out.BytesPerSecond = &rate
		}
	}()
	if j.Validate(j.Scope) != nil || j.Status != "running" || j.AttemptID == "" {
		return
	}
	if !start.Before(j.ExpiresAt) {
		out.Code = "expired"
		out.Action = "Create a new diagnostic; the queued request expired."
		return
	}
	select {
	case e.slot <- struct{}{}:
		defer func() { <-e.slot }()
	default:
		out.Code = "busy"
		out.Action = "Wait for the current node diagnostic to finish."
		return
	}
	if parent.Err() != nil {
		out.Code = "cancelled_before_start"
		out.Action = "Request a new diagnostic when ready."
		return
	}
	dial := resources.PublicDialer()
	raw := j.Target.URL
	if err := resources.ValidateHTTPSURL(raw); err != nil {
		u, parseErr := url.Parse(raw)
		if parseErr != nil || e.loopback[j.Target.ID] != raw || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || u.Opaque != "" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() {
			out.Code = "target_denied"
			out.Action = "Authorize a public HTTPS target; private, metadata and credential-bearing URLs are blocked."
			return
		}
		// Exact literal address is rechecked at dial time. No DNS or proxy can swap it.
		expected := u.Host
		dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != expected {
				return nil, resources.ErrAddress
			}
			return (&net.Dialer{}).DialContext(ctx, network, address)
		}
	}
	if j.PathMode == "managed_route" {
		if j.ManagedPath == nil || e.routeDialer == nil {
			out.Code = "managed_probe_unavailable"
			out.Action = "Use a registered managed runtime with route probing support."
			return
		}
		local := e.loopback[j.Target.ID] == raw
		dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, resources.ErrAddress
			}
			if local {
				return e.routeDialer(ctx, *j.ManagedPath, network, address)
			}
			addresses, err := resources.ResolvePublicAddresses(ctx, host)
			if err != nil {
				return nil, err
			}
			// Exactly one pinned address and one native connection; never direct fallback.
			return e.routeDialer(ctx, *j.ManagedPath, network, net.JoinHostPort(addresses[0].Unmap().String(), port))
		}
	}
	deadline := start.Add(time.Duration(j.TimeoutSeconds) * time.Second)
	if j.ExpiresAt.Before(deadline) {
		deadline = j.ExpiresAt
	}
	// A delayed claim response cannot start traffic after the control plane may
	// release its node lane. Ten seconds of delivery grace leaves five seconds
	// for cancellation/result delivery before the CP marks a missing result.
	if j.ClaimedAt != nil {
		claimDeadline := j.ClaimedAt.Add(time.Duration(j.TimeoutSeconds+10) * time.Second)
		if claimDeadline.Before(deadline) {
			deadline = claimDeadline
		}
	}
	if !start.Before(deadline) {
		out.Code = "claim_expired"
		out.Action = "The claim arrived too late. Request a new diagnostic."
		return
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	var mu sync.Mutex
	phase := "connect"
	setPhase := func(p string) { mu.Lock(); phase = p; mu.Unlock() }
	getPhase := func() string { mu.Lock(); defer mu.Unlock(); return phase }
	wrote := make(chan error, 1)
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		select {
		case wrote <- info.Err:
		default:
		}
	}, TLSHandshakeStart: func() { setPhase("tls") }, GotConn: func(httptrace.GotConnInfo) { setPhase("http") }}
	ctx = httptrace.WithClientTrace(ctx, trace)
	tr := &http.Transport{Proxy: nil, DialContext: dial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: time.Duration(j.TimeoutSeconds) * time.Second, ResponseHeaderTimeout: time.Duration(j.TimeoutSeconds) * time.Second, MaxResponseHeaderBytes: 16 << 10, DisableKeepAlives: true, DisableCompression: true, ForceAttemptHTTP2: false, MaxConnsPerHost: 1}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	method := http.MethodHead
	var body io.Reader
	payload := &diagnosticPayload{remaining: j.MaxBytes}
	uploadAttempted, wroteObserved, writeCompleted := false, false, false
	defer func() {
		if !uploadAttempted {
			return
		}
		cancel()
		_ = payload.Close()
		if !wroteObserved {
			select {
			case writeErr := <-wrote:
				wroteObserved = true
				writeCompleted = writeErr == nil
			case <-time.After(time.Second):
				out.Status = "unknown"
				out.Code = "upload_completion_unknown"
				out.Action = "The local HTTP writer did not confirm completion. No retry was performed."
			}
		}
		out.BytesSent = payload.sent.Load()
		// Reader counts alone are not successful writes. Failed/uncertain uploads
		// preserve bounded estimates but never claim exact sent cost or throughput.
		if out.Status != "succeeded" || !writeCompleted {
			out.CostKnown = false
			out.BytesPerSecond = nil
		}
	}()
	if j.Kind == "download" {
		method = http.MethodGet
	}
	if j.Kind == "upload" {
		method = http.MethodPut
		body = payload
	}
	req, err := http.NewRequestWithContext(ctx, method, raw, body)
	if err != nil {
		return
	}
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "RouteWeaver-Diagnostic/1")
	if j.Kind == "download" {
		req.Header.Set("Range", "bytes=0-"+strconv.FormatInt(j.MaxBytes-1, 10))
	}
	if j.Kind == "upload" {
		req.ContentLength = j.MaxBytes
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	out.Status = "failed"
	out.Phase = "connect"
	uploadAttempted = j.Kind == "upload"
	response, err := client.Do(req)
	out.BytesSent = payload.sent.Load()
	if err != nil {
		out.Phase = getPhase()
		out.Code = "connection_failed"
		out.Action = "Check the authorized target listener, DNS and node egress rules."
		if out.Phase == "tls" {
			out.Code = "tls_failed"
			out.Action = "Check the target certificate, hostname and TLS listener; verification is never bypassed."
		}
		if errors.Is(err, resources.ErrAddress) || errors.Is(err, resources.ErrURL) {
			out.Code = "target_denied"
			out.Action = "Use a public target; every resolved address must be public."
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			out.Code = "deadline_exceeded"
			out.Action = "Check the target and egress path, or retry within the 30-second limit."
		}
		diagnosticContextError(ctx, &out)
		return
	}
	defer response.Body.Close()
	if j.Kind == "upload" {
		var writeErr error
		select {
		case writeErr = <-wrote:
			wroteObserved = true
			writeCompleted = writeErr == nil
		case <-ctx.Done():
			writeErr = ctx.Err()
		}
		if writeErr != nil || payload.sent.Load() != j.MaxBytes {
			out.Phase = "transfer"
			out.Code = "upload_incomplete"
			out.Action = "The complete request was not written. Check the authorized PUT sink and node egress path."
			diagnosticContextError(ctx, &out)
			return
		}
		out.BytesSent = payload.sent.Load()
	}
	out.HTTPStatus = response.StatusCode
	out.Phase = "http"
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		out.Code = "http_rejected"
		out.Action = "Configure the authorized target to support the selected HEAD, ranged GET or PUT method without redirects."
		return
	}
	if response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		out.Code = "encoding_unsupported"
		out.Action = "Disable content compression on the diagnostic target."
		return
	}
	setPhase("transfer")
	out.Phase = "transfer"
	if j.Kind == "download" {
		if response.ContentLength != j.MaxBytes {
			out.Code = "unexpected_download_size"
			out.Action = "Configure the target to return exactly the requested byte range with Content-Length."
			return
		}
		out.BytesReceived, err = io.CopyN(io.Discard, response.Body, j.MaxBytes)
	} else if j.Kind == "upload" {
		if response.ContentLength > diagnostics.UploadResponseBytes {
			out.Code = "response_too_large"
			out.Action = "Configure the upload target to return an empty or small acknowledgement."
			return
		}
		out.BytesReceived, err = io.Copy(io.Discard, io.LimitReader(response.Body, diagnostics.UploadResponseBytes))
		if err == nil && response.ContentLength < 0 && out.BytesReceived == diagnostics.UploadResponseBytes {
			out.Code = "response_limit_reached"
			out.Action = "Configure the upload target to return an empty or small acknowledgement."
			return
		}
		if err == nil && out.BytesSent != j.MaxBytes {
			out.Code = "upload_incomplete"
			out.Action = "Configure the authorized PUT sink and verify that it accepts the full request body."
			return
		}
	}
	if err != nil {
		out.Code = "transfer_failed"
		out.Action = "Check the target and network path, then retry with a smaller payload."
		diagnosticContextError(ctx, &out)
		return
	}
	if ctx.Err() != nil {
		diagnosticContextError(ctx, &out)
		return
	}
	out.Status = "succeeded"
	out.Phase = "complete"
	out.Code = "completed"
	out.Action = ""

	return
}
func diagnosticContextError(ctx context.Context, out *diagnostics.Result) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		out.Code = "deadline_exceeded"
		out.Action = "Check the target and egress path, or retry within the 30-second limit."
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		out.Status = "cancelled"
		out.Code = "cancelled"
		out.Action = "No automatic retry was performed."
	}
}

type diagnosticPayload struct {
	remaining int64
	sent      atomic.Int64
	closed    atomic.Bool
}

func (p *diagnosticPayload) Read(b []byte) (int, error) {
	if p.closed.Load() || p.remaining == 0 {
		return 0, io.EOF
	}
	n := int64(len(b))
	if n > p.remaining {
		n = p.remaining
	}
	clear(b[:n])
	p.remaining -= n
	p.sent.Add(n)
	return int(n), nil
}

func (p *diagnosticPayload) Close() error { p.closed.Store(true); return nil }
