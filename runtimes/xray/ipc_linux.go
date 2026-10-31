//go:build linux

package managedxray

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"routeweaver/internal/entrypolicy"
)

// SocketAdmission exposes only acquire/release over a private same-UID Unix
// socket. The managed core never receives a control-plane URL or bearer token.
type SocketAdmission struct {
	client    *http.Client
	transport *http.Transport
}

func privateDirectory(path string) error {
	if !filepath.IsAbs(path) || len(path) > 100 {
		return errors.New("bounded absolute Unix socket path required")
	}
	dir := filepath.Dir(path)
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	uid, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || st.Mode().Perm()&0077 != 0 || !ok || uid.Uid != uint32(os.Getuid()) {
		return errors.New("Unix socket needs an owner-only directory")
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || resolved != dir {
		return errors.New("Unix socket directory must not be a symlink")
	}
	return nil
}
func samePeer(c net.Conn) bool {
	u, ok := c.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return false
	}
	allowed := false
	err = raw.Control(func(fd uintptr) {
		cred, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		allowed = e == nil && cred.Uid == uint32(os.Getuid())
	})
	return err == nil && allowed
}
func NewSocketAdmission(path string) (*SocketAdmission, error) {
	if err := privateDirectory(path); err != nil {
		return nil, err
	}
	tr := &http.Transport{Proxy: nil, MaxConnsPerHost: 32, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 2 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		c, e := (&net.Dialer{}).DialContext(ctx, "unix", path)
		if e != nil {
			return nil, e
		}
		if !samePeer(c) {
			c.Close()
			return nil, errors.New("untrusted admission peer")
		}
		return c, nil
	}}
	return &SocketAdmission{client: &http.Client{Transport: tr, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport: tr}, nil
}
func (s *SocketAdmission) Close() { s.transport.CloseIdleConnections() }
func (s *SocketAdmission) Acquire(ctx context.Context, in entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	var out entrypolicy.Lease
	b, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://agent/v1/admission-leases", bytes.NewReader(b))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return out, errors.New("admission broker unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, errors.New("admission broker rejected request")
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 16384))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&out); err != nil {
		return out, errors.New("invalid admission response")
	}
	if dec.Decode(new(any)) != io.EOF {
		return out, errors.New("trailing admission response")
	}
	return out, nil
}
func (s *SocketAdmission) Release(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, "http://agent/v1/admission-leases/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return errors.New("admission release failed")
	}
	return nil
}

type peerKey struct{}

// ServeControl offers a bounded local snapshot and sticky account revocation,
// not a shell, native reload API or arbitrary remote command surface.
func (r *Runtime) ServeControl(path string) (func() error, error) {
	if err := privateDirectory(path); err != nil {
		return nil, err
	}
	l, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		l.Close()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/snapshot", func(w http.ResponseWriter, q *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.Snapshot())
	})
	mux.HandleFunc("POST /v1/accounts/{account}/revoke", func(w http.ResponseWriter, q *http.Request) {
		account := q.PathValue("account")
		if !identifier.MatchString(account) || strings.Contains(account, "/") {
			http.Error(w, "invalid account", 400)
			return
		}
		r.RevokeAccount(account)
		w.WriteHeader(204)
	})
	srv := &http.Server{ReadHeaderTimeout: time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192, ConnContext: func(ctx context.Context, c net.Conn) context.Context {
		return context.WithValue(ctx, peerKey{}, samePeer(c))
	}, Handler: http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if q.Context().Value(peerKey{}) != true {
			http.Error(w, "untrusted local peer", 403)
			return
		}
		mux.ServeHTTP(w, q)
	})}
	go func() { _ = srv.Serve(l) }()
	return func() error { return srv.Close() }, nil
}
