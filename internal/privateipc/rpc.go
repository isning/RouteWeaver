// Package privateipc implements the fixed managed-runtime protocol over channels
// whose ownership is established by inherited anonymous descriptors. It is not a
// listener, shell, enrollment service or general-purpose remote object registry.
package privateipc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/rpc"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"routeweaver/internal/entrypolicy"
)

const ProtocolVersion = 1
const maxFrame = 4 << 20

type Duplex struct {
	reader io.ReadCloser
	writer io.WriteCloser
	once   sync.Once
	done   chan struct{}
}

func NewDuplex(r io.ReadCloser, w io.WriteCloser) *Duplex {
	return &Duplex{reader: r, writer: w, done: make(chan struct{})}
}
func (d *Duplex) Read(p []byte) (int, error) {
	n, e := d.reader.Read(p)
	if e != nil {
		d.Close()
	}
	return n, e
}
func (d *Duplex) Write(p []byte) (int, error) {
	n, e := d.writer.Write(p)
	if e != nil {
		d.Close()
	}
	return n, e
}
func (d *Duplex) Close() error {
	d.once.Do(func() { close(d.done); d.reader.Close(); d.writer.Close() })
	return nil
}
func (d *Duplex) Done() <-chan struct{} { return d.done }

type frame struct {
	Version  int             `json:"version"`
	Method   string          `json:"method,omitempty"`
	Sequence uint64          `json:"sequence"`
	Error    string          `json:"error,omitempty"`
	Body     json.RawMessage `json:"body"`
}
type codec struct {
	channel   io.ReadWriteCloser
	mu        sync.Mutex
	body      json.RawMessage
	readLimit uint32
}

func newCodec(channel io.ReadWriteCloser, limit uint32) *codec {
	return &codec{channel: channel, readLimit: limit}
}
func (c *codec) read() (frame, error) {
	var f frame
	var size uint32
	if e := binary.Read(c.channel, binary.BigEndian, &size); e != nil {
		return f, e
	}
	if size == 0 || size > c.readLimit {
		c.channel.Close()
		return f, errors.New("private IPC frame exceeds bound")
	}
	b := make([]byte, size)
	if _, e := io.ReadFull(c.channel, b); e != nil {
		return f, e
	}
	if e := strictJSON(b, &f); e != nil || f.Version != ProtocolVersion {
		c.channel.Close()
		return f, errors.New("private IPC version or JSON mismatch")
	}
	c.body = f.Body
	return f, nil
}
func (c *codec) write(f frame) error {
	f.Version = ProtocolVersion
	b, e := json.Marshal(f)
	if e != nil {
		return e
	}
	if len(b) > maxFrame {
		return errors.New("private IPC frame exceeds bound")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(b)))
	if e = writeAll(c.channel, prefix[:]); e != nil {
		return e
	}
	return writeAll(c.channel, b)
}
func (c *codec) ReadRequestHeader(r *rpc.Request) error {
	f, e := c.read()
	r.ServiceMethod = f.Method
	r.Seq = f.Sequence
	return e
}
func (c *codec) ReadResponseHeader(r *rpc.Response) error {
	f, e := c.read()
	r.ServiceMethod = f.Method
	r.Seq = f.Sequence
	r.Error = f.Error
	return e
}
func (c *codec) decode(body any) error {
	if body == nil {
		c.body = nil
		return nil
	}
	e := strictJSON(c.body, body)
	if e != nil {
		c.channel.Close()
	}
	c.body = nil
	return e
}
func (c *codec) ReadRequestBody(b any) error  { return c.decode(b) }
func (c *codec) ReadResponseBody(b any) error { return c.decode(b) }
func (c *codec) WriteRequest(r *rpc.Request, body any) error {
	b, e := json.Marshal(body)
	if e != nil {
		return e
	}
	return c.write(frame{Method: r.ServiceMethod, Sequence: r.Seq, Body: b})
}
func (c *codec) WriteResponse(r *rpc.Response, body any) error {
	b, e := json.Marshal(body)
	if e != nil {
		return e
	}
	return c.write(frame{Method: r.ServiceMethod, Sequence: r.Seq, Error: r.Error, Body: b})
}
func (c *codec) Close() error { return c.channel.Close() }

type client struct {
	rpc   *rpc.Client
	slots chan struct{}
}

func newClient(d *Duplex, limit uint32) *client {
	return &client{rpc: rpc.NewClientWithCodec(newCodec(d, limit)), slots: make(chan struct{}, 32)}
}
func (c *client) call(ctx context.Context, method string, in, out any) error {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	// Keep the bounded permit until the pending RPC actually finishes. Replies
	// decode into private storage so cancellation never races the caller's value.
	// One slow CP request does not close healthy peers' last-good leases.
	reply := reflect.New(reflect.TypeOf(out).Elem()).Interface()
	done := make(chan error, 1)
	go func() { err := c.rpc.Call(method, in, reply); <-c.slots; done <- err }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		if err == nil {
			reflect.ValueOf(out).Elem().Set(reflect.ValueOf(reply).Elem())
		}
		return err
	}
}

func (c *client) Close() error { return c.rpc.Close() }

// RPC request/reply types are exported only for net/rpc's fixed typed dispatch.
type AcquireRequest struct {
	Deadline time.Time
	Request  entrypolicy.AdmissionRequest
}
type ReleaseRequest struct {
	Deadline time.Time
	LeaseID  string
}
type Empty struct{}
type admissionRPC struct{ authority entrypolicy.Admission }

func deadlineContext(deadline time.Time) (context.Context, context.CancelFunc) {
	limit := time.Now().Add(2 * time.Second)
	if !deadline.IsZero() && deadline.Before(limit) {
		limit = deadline
	}
	return context.WithDeadline(context.Background(), limit)
}
func (a *admissionRPC) Acquire(q AcquireRequest, out *entrypolicy.Lease) error {
	ctx, cancel := deadlineContext(q.Deadline)
	defer cancel()
	l, e := a.authority.Acquire(ctx, q.Request)
	if e != nil {
		return errors.New("authoritative admission unavailable")
	}
	*out = l
	return nil
}
func (a *admissionRPC) Release(q ReleaseRequest, _ *Empty) error {
	ctx, cancel := deadlineContext(q.Deadline)
	defer cancel()
	if e := a.authority.Release(ctx, q.LeaseID); e != nil {
		return errors.New("authoritative release unavailable")
	}
	return nil
}
func ServeAdmission(d *Duplex, a entrypolicy.Admission) {
	server := rpc.NewServer()
	if server.RegisterName("Admission", &admissionRPC{authority: a}) != nil {
		d.Close()
		return
	}
	server.ServeCodec(newCodec(d, 16384))
	d.Close()
}

type AdmissionClient struct {
	*client
	channel *Duplex
}

func NewAdmissionClient(d *Duplex) *AdmissionClient {
	return &AdmissionClient{client: newClient(d, 16384), channel: d}
}
func (a *AdmissionClient) Acquire(ctx context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	var out entrypolicy.Lease
	deadline, _ := ctx.Deadline()
	e := a.call(ctx, "Admission.Acquire", AcquireRequest{Deadline: deadline, Request: q}, &out)
	return out, e
}
func (a *AdmissionClient) Release(ctx context.Context, id string) error {
	deadline, _ := ctx.Deadline()
	return a.call(ctx, "Admission.Release", ReleaseRequest{Deadline: deadline, LeaseID: id}, new(Empty))
}
func (a *AdmissionClient) Done() <-chan struct{} { return a.channel.Done() }

type Controller interface {
	Snapshot() entrypolicy.Snapshot
	RevokeAccount(string)
}
type RevokeRequest struct{ AccountID string }
type controlRPC struct {
	controller Controller
	context    context.Context
}

var validAccount = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (c *controlRPC) Snapshot(_ Empty, out *entrypolicy.Snapshot) error {
	*out = c.controller.Snapshot()
	return nil
}
func (c *controlRPC) Revoke(q RevokeRequest, _ *Empty) error {
	if !validAccount.MatchString(q.AccountID) {
		return errors.New("invalid account identity")
	}
	c.controller.RevokeAccount(q.AccountID)
	return nil
}
func ServeControl(d *Duplex, c Controller) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-d.Done():
			cancel()
		case <-ctx.Done():
		}
	}()
	server := rpc.NewServer()
	if server.RegisterName("Control", &controlRPC{controller: c, context: ctx}) != nil {
		d.Close()
		return
	}
	server.ServeCodec(newCodec(d, 64<<10))
	d.Close()
}

type ControlClient struct{ *client }

func NewControlClient(d *Duplex) *ControlClient {
	return &ControlClient{client: newClient(d, maxFrame)}
}
func (c *ControlClient) Snapshot(ctx context.Context) (entrypolicy.Snapshot, error) {
	var out entrypolicy.Snapshot
	e := c.call(ctx, "Control.Snapshot", Empty{}, &out)
	return out, e
}
func (c *ControlClient) Revoke(ctx context.Context, account string) error {
	return c.call(ctx, "Control.Revoke", RevokeRequest{AccountID: account}, new(Empty))
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, e := w.Write(p)
		if n < 0 || n > len(p) {
			return io.ErrShortWrite
		}
		p = p[n:]
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
func strictJSON(b []byte, out any) error {
	duplicate := json.NewDecoder(bytes.NewReader(b))
	if e := uniqueValue(duplicate); e != nil {
		return e
	}
	if _, e := duplicate.Token(); e != io.EOF {
		return errors.New("trailing private IPC JSON")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		return errors.New("unknown or invalid private IPC field")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing private IPC JSON")
	}
	return nil
}
func uniqueValue(d *json.Decoder) error {
	t, e := d.Token()
	if e != nil {
		return e
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, e := d.Token()
			if e != nil {
				return e
			}
			name, ok := key.(string)
			if !ok {
				return errors.New("invalid private IPC key")
			}
			name = strings.ToLower(name)
			if seen[name] {
				return errors.New("duplicate private IPC field")
			}
			seen[name] = true
			if e = uniqueValue(d); e != nil {
				return e
			}
		}
		_, e = d.Token()
		return e
	case '[':
		for d.More() {
			if e = uniqueValue(d); e != nil {
				return e
			}
		}
		_, e = d.Token()
		return e
	default:
		return errors.New("invalid private IPC delimiter")
	}
}
