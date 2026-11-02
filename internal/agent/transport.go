package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"routeweaver/internal/domain"
)

type HTTPTransportOptions struct {
	BaseURL string
	// Token is supplied by an operator's approved enrollment procedure. It is
	// never generated, logged, returned, or persisted by this transport.
	Token          string
	Scope          Scope
	RootCAs        *x509.CertPool
	RequestTimeout time.Duration
	MaxAttempts    int
	Backoff        time.Duration
	// Only explicit literal loopback addresses are eligible. Production has no
	// option to disable TLS certificate/hostname verification.
	AllowLoopbackHTTP bool
}
type HTTPTransport struct {
	base      string
	token     string
	scope     Scope
	client    *http.Client
	attempts  int
	backoff   time.Duration
	transport *http.Transport
}
type TransportError struct {
	Status int
	Code   string
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("agent transport: %s (HTTP %d)", e.Code, e.Status)
}

func NewHTTPTransport(o HTTPTransportOptions) (*HTTPTransport, error) {
	u, err := url.Parse(o.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("control-plane origin must not contain userinfo, path, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(o.AllowLoopbackHTTP && u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
		return nil, errors.New("verified HTTPS required; HTTP is only for explicitly enabled loopback tests")
	}
	if o.Token == "" || len(o.Token) > 8192 || strings.ContainsAny(o.Token, "\r\n\x00") {
		return nil, errors.New("operator-supplied scoped token required")
	}
	if !domain.ValidID(o.Scope.NodeID) || !domain.ValidID(o.Scope.InstanceID) || !domain.ValidID(o.Scope.EnrollmentEpoch) {
		return nil, errors.New("valid enrolled scope required")
	}
	if o.RequestTimeout <= 0 || o.RequestTimeout > time.Minute || o.MaxAttempts < 1 || o.MaxAttempts > 5 || o.Backoff <= 0 || o.Backoff > 10*time.Second {
		return nil, errors.New("explicit bounded transport timeout and retry policy required")
	}
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: o.RequestTimeout, KeepAlive: 30 * time.Second}).DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: o.RootCAs}, TLSHandshakeTimeout: o.RequestTimeout, ResponseHeaderTimeout: o.RequestTimeout, IdleConnTimeout: 30 * time.Second, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, MaxConnsPerHost: 2, MaxResponseHeaderBytes: 32 << 10}
	client := &http.Client{Transport: tr, Timeout: o.RequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &HTTPTransport{base: strings.TrimRight(u.String(), "/"), token: o.Token, scope: o.Scope, client: client, transport: tr, attempts: o.MaxAttempts, backoff: o.Backoff}, nil
}
func (t *HTTPTransport) Close() { t.transport.CloseIdleConnections() }
func (t *HTTPTransport) endpoint(suffix string) string {
	return "/api/agent/instances/" + url.PathEscape(t.scope.InstanceID) + suffix
}
func (t *HTTPTransport) request(ctx context.Context, method, path string, payload any) ([]byte, int, error) {
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, 0, errors.New("invalid transport payload")
		}
		if len(body) > 12<<20 {
			return nil, 0, errors.New("transport payload exceeds byte limit")
		}
	}
	key := ""
	if method != "GET" {
		sum := sha256.Sum256(body)
		key = hex.EncodeToString(sum[:])
	}
	for attempt := 0; attempt < t.attempts; attempt++ {
		if err = ctx.Err(); err != nil {
			return nil, 0, err
		}
		req, err := http.NewRequestWithContext(ctx, method, t.base+path, bytes.NewReader(body))
		if err != nil {
			return nil, 0, errors.New("invalid control-plane request")
		}
		req.Header.Set("Authorization", "Bearer "+t.token)
		req.Header.Set("X-RouteWeaver-Node", t.scope.NodeID)
		req.Header.Set("X-RouteWeaver-Enrollment", t.scope.EnrollmentEpoch)
		req.Header.Set("Accept", "application/json")
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", key)
		}
		response, requestErr := t.client.Do(req)
		retry := false
		var result []byte
		var status int
		if requestErr != nil {
			if ctx.Err() != nil {
				return nil, 0, ctx.Err()
			}
			retry = true
			err = &TransportError{Code: "request_failed"}
		} else {
			status = response.StatusCode
			retry = status == 429 || status == 502 || status == 503 || status == 504
			result, err = io.ReadAll(io.LimitReader(response.Body, (12<<20)+1))
			closeErr := response.Body.Close()
			if err != nil || closeErr != nil {
				if ctx.Err() != nil {
					return nil, status, ctx.Err()
				}
				// A truncated acknowledgement is just as uncertain as a lost
				// connection before headers. Retry the exact serialized payload
				// and idempotency key under the same bounded attempt policy.
				err = &TransportError{Status: status, Code: "response_read_failed"}
				retry = retry || status >= 200 && status < 300
			} else if len(result) > 12<<20 {
				return nil, status, &TransportError{Status: status, Code: "response_too_large"}
			} else if status >= 200 && status < 300 {
				return result, status, nil
			} else {
				// Redirects are never followed with this agent's scoped bearer credential.
				err = &TransportError{Status: status, Code: "request_rejected"}
			}
		}
		if !retry || attempt == t.attempts-1 {
			return nil, status, err
		}
		delay := t.backoff * time.Duration(1<<attempt)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, status, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, 0, errors.New("transport attempt bound reached")
}
func decodeWire(b []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return errors.New("invalid control-plane response")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing control-plane response")
	}
	return nil
}
func (t *HTTPTransport) ReceiveDesired(ctx context.Context, scope Scope, after uint64) (*Desired, error) {
	if scope != t.scope {
		return nil, errors.New("transport scope mismatch")
	}
	b, status, err := t.request(ctx, http.MethodGet, t.endpoint("/desired")+"?after="+strconv.FormatUint(after, 10), nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	var d Desired
	if err = decodeWire(b, &d); err != nil {
		return nil, err
	}
	if err = validateDesired(d, scope); err != nil {
		return nil, errors.New("desired envelope scope or integrity mismatch")
	}
	if d.Generation <= after {
		return nil, ErrStaleGeneration
	}
	return &d, nil
}
func (t *HTTPTransport) ReportObservation(ctx context.Context, scope Scope, state State) error {
	if scope != t.scope {
		return errors.New("transport scope mismatch")
	}
	if state.Desired != nil && state.Desired.Scope != scope {
		return errors.New("observation desired scope mismatch")
	}
	if state.LastKnownValid != nil && state.LastKnownValid.Scope != scope {
		return errors.New("last-valid observation scope mismatch")
	}
	if state.Observed != nil && state.Observed.Scope != scope {
		return errors.New("observation scope mismatch")
	}
	_, _, err := t.request(ctx, http.MethodPost, t.endpoint("/observations"), state)
	return err
}
func (t *HTTPTransport) SendMeterBatch(ctx context.Context, batch MeterBatch) (MeterReceipt, error) {
	if batch.Scope != t.scope {
		return MeterReceipt{}, errors.New("transport meter scope mismatch")
	}
	b, _, err := t.request(ctx, http.MethodPost, t.endpoint("/meter-batches"), batch)
	if err != nil {
		return MeterReceipt{}, err
	}
	var receipt MeterReceipt
	if err = decodeWire(b, &receipt); err != nil {
		return MeterReceipt{}, err
	}
	if receipt.StreamEpoch != batch.StreamEpoch || receipt.Sequence != batch.Sequence || receipt.Digest != batch.Digest {
		return MeterReceipt{}, errors.New("meter receipt scope or digest mismatch")
	}
	if err := validateCustodyReceipt(batch, receipt); err != nil {
		return MeterReceipt{}, err
	}
	return receipt, nil
}
