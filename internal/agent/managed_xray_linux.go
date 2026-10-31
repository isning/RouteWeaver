//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"syscall"
	"time"
)

type admissionPeerKey struct{}

func privateSocketPath(path string) error {
	if !filepath.IsAbs(path) || len(path) > 100 {
		return errors.New("bounded absolute private socket path required")
	}
	dir := filepath.Dir(path)
	st, e := os.Lstat(dir)
	if e != nil {
		return e
	}
	s, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || st.Mode().Perm()&0077 != 0 || !ok || s.Uid != uint32(os.Getuid()) {
		return errors.New("socket directory must be owned and private")
	}
	resolved, e := filepath.EvalSymlinks(dir)
	if e != nil || resolved != dir {
		return errors.New("socket path cannot traverse symlinks")
	}
	return nil
}
func managedPeer(c net.Conn) bool {
	u, ok := c.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, e := u.SyscallConn()
	if e != nil {
		return false
	}
	allowed := false
	e = raw.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		allowed = err == nil && cred.Uid == uint32(os.Getuid())
	})
	return e == nil && allowed
}

// AdmissionBroker retains the enrolled HTTP transport in the agent. The native
// process receives only a same-UID, owner-directory Unix socket with two methods.
type UnixAdmissionBroker struct{ server *http.Server }

func StartUnixAdmissionBroker(root string, a entrypolicy.Admission) (*UnixAdmissionBroker, error) {
	path := ManagedAdmissionSocket(root)
	if a == nil {
		return nil, errors.New("authoritative admission required")
	}
	if e := privateSocketPath(path); e != nil {
		return nil, e
	}
	if st, e := os.Lstat(path); e == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("admission socket path already contains a non-socket")
		}
		c, dialErr := net.DialTimeout("unix", path, 100*time.Millisecond)
		if dialErr == nil {
			c.Close()
			return nil, errors.New("admission broker already active")
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, errors.New("existing admission socket outcome is uncertain")
		}
		if e = os.Remove(path); e != nil {
			return nil, e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	l, e := net.Listen("unix", path)
	if e != nil {
		return nil, e
	}
	if e = os.Chmod(path, 0600); e != nil {
		l.Close()
		return nil, e
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/admission-leases", func(w http.ResponseWriter, q *http.Request) {
		var request entrypolicy.AdmissionRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, q.Body, 8192))
		dec.DisallowUnknownFields()
		if dec.Decode(&request) != nil || dec.Decode(new(any)) != io.EOF {
			http.Error(w, "invalid request", 400)
			return
		}
		ctx, cancel := context.WithTimeout(q.Context(), 2*time.Second)
		defer cancel()
		lease, e := a.Acquire(ctx, request)
		if e != nil {
			http.Error(w, "admission unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(lease)
	})
	mux.HandleFunc("DELETE /v1/admission-leases/{id}", func(w http.ResponseWriter, q *http.Request) {
		id := q.PathValue("id")
		if !domain.ValidID(id) {
			http.Error(w, "invalid lease", 400)
			return
		}
		ctx, cancel := context.WithTimeout(q.Context(), time.Second)
		defer cancel()
		if e := a.Release(ctx, id); e != nil {
			http.Error(w, "release unavailable", 503)
			return
		}
		w.WriteHeader(204)
	})
	srv := &http.Server{ReadHeaderTimeout: time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192, ConnContext: func(ctx context.Context, c net.Conn) context.Context {
		return context.WithValue(ctx, admissionPeerKey{}, managedPeer(c))
	}, Handler: http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		if q.Context().Value(admissionPeerKey{}) != true {
			http.Error(w, "untrusted local peer", 403)
			return
		}
		mux.ServeHTTP(w, q)
	})}
	go func() { _ = srv.Serve(l) }()
	return &UnixAdmissionBroker{server: srv}, nil
}
func (b *UnixAdmissionBroker) Close() error { return b.server.Close() }
func managedControlRequest(ctx context.Context, root, method, path string, out any) error {
	socket := ManagedControlSocket(root)
	if e := privateSocketPath(socket); e != nil {
		return e
	}
	tr := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		c, e := (&net.Dialer{}).DialContext(ctx, "unix", socket)
		if e != nil {
			return nil, e
		}
		if !managedPeer(c) {
			c.Close()
			return nil, errors.New("untrusted runtime peer")
		}
		return c, nil
	}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	q, e := http.NewRequestWithContext(ctx, method, "http://runtime"+path, nil)
	if e != nil {
		return e
	}
	res, e := client.Do(q)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return errors.New("managed runtime request rejected")
	}
	if out == nil {
		return nil
	}
	dec := json.NewDecoder(io.LimitReader(res.Body, 4<<20))
	dec.DisallowUnknownFields()
	if e = dec.Decode(out); e != nil {
		return e
	}
	if dec.Decode(new(any)) != io.EOF {
		return errors.New("trailing managed snapshot")
	}
	return nil
}
func ReadManagedUnixSnapshot(ctx context.Context, root string) (entrypolicy.Snapshot, error) {
	var s entrypolicy.Snapshot
	e := managedControlRequest(ctx, root, http.MethodGet, "/v1/snapshot", &s)
	return s, e
}
func RevokeManagedUnixAccount(ctx context.Context, root, account string) error {
	if !domain.ValidID(account) {
		return errors.New("invalid account")
	}
	return managedControlRequest(ctx, root, http.MethodPost, "/v1/accounts/"+url.PathEscape(account)+"/revoke", nil)
}
