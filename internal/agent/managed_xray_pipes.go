package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/privateipc"
)

type AdmissionBroker struct {
	root      string
	authority entrypolicy.Admission
	mu        sync.Mutex
	session   *managedPipeSession
	closed    bool
}
type managedPipeSession struct {
	identity    Identity
	admission   *privateipc.Duplex
	controlPipe *privateipc.Duplex
	control     *privateipc.ControlClient
	once        sync.Once
}

func (s *managedPipeSession) close() {
	s.once.Do(func() { s.control.Close(); s.admission.Close(); s.controlPipe.Close() })
}

var managedBrokers = struct {
	sync.Mutex
	byRoot map[string]*AdmissionBroker
}{byRoot: map[string]*AdmissionBroker{}}

// StartAdmissionBroker installs a local pipe authority. It binds no socket and
// exposes no network port. Only descriptors inherited by its owned child can
// reach the fixed admission operations; no bearer credential crosses the pipes.
func StartAdmissionBroker(root string, a entrypolicy.Admission) (*AdmissionBroker, error) {
	if !filepath.IsAbs(root) || a == nil {
		return nil, errors.New("absolute private root and authority required")
	}
	st, e := os.Lstat(root)
	if e != nil {
		return nil, e
	}
	if !st.IsDir() || st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private real agent root required")
	}
	managedBrokers.Lock()
	defer managedBrokers.Unlock()
	if _, exists := managedBrokers.byRoot[root]; exists {
		return nil, errors.New("admission broker already registered")
	}
	b := &AdmissionBroker{root: root, authority: a}
	managedBrokers.byRoot[root] = b
	return b, nil
}
func (b *AdmissionBroker) Close() error {
	managedBrokers.Lock()
	if managedBrokers.byRoot[b.root] == b {
		delete(managedBrokers.byRoot, b.root)
	}
	managedBrokers.Unlock()
	b.mu.Lock()
	b.closed = true
	s := b.session
	b.session = nil
	b.mu.Unlock()
	if s != nil {
		s.close()
	}
	return nil
}
func pipeBroker(root string) (*AdmissionBroker, error) {
	managedBrokers.Lock()
	b := managedBrokers.byRoot[root]
	managedBrokers.Unlock()
	if b == nil {
		return nil, errors.New("managed pipe broker is not registered")
	}
	return b, nil
}
func prepareManagedPipes(st Staged) (*ProcessIO, error) {
	b, e := pipeBroker(st.Root)
	if e != nil {
		return nil, e
	}
	// Child: admission response-read3/request-write4, control request-read5/response-write6.
	var files []*os.File
	pair := func() (*os.File, *os.File, error) {
		r, w, e := os.Pipe()
		if e == nil {
			files = append(files, r, w)
		}
		return r, w, e
	}
	ar, aw, e := pair()
	if e != nil {
		return nil, e
	}
	rr, rw, e := pair()
	if e != nil {
		for _, f := range files {
			f.Close()
		}
		return nil, e
	}
	cr, cw, e := pair()
	if e != nil {
		for _, f := range files {
			f.Close()
		}
		return nil, e
	}
	sr, sw, e := pair()
	if e != nil {
		for _, f := range files {
			f.Close()
		}
		return nil, e
	}
	admission := privateipc.NewDuplex(ar, rw)
	controlPipe := privateipc.NewDuplex(sr, cw)
	s := &managedPipeSession{identity: st.Desired.Identity(), admission: admission, controlPipe: controlPipe, control: privateipc.NewControlClient(controlPipe)}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		for _, f := range files {
			f.Close()
		}
		return nil, errors.New("admission broker closed")
	}
	old := b.session
	b.session = s
	b.mu.Unlock()
	if old != nil {
		old.close()
	}
	child := []*os.File{rr, aw, cr, sw}
	go privateipc.ServeAdmission(admission, b.authority)
	closeChild := func() {
		for _, f := range child {
			f.Close()
		}
	}
	return &ProcessIO{ExtraFiles: child, AfterStart: closeChild, OnExit: func() {
		closeChild()
		s.close()
		b.mu.Lock()
		if b.session == s {
			b.session = nil
		}
		b.mu.Unlock()
	}}, nil
}
func pipeControl(root string) (*privateipc.ControlClient, error) {
	b, e := pipeBroker(root)
	if e != nil {
		return nil, e
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.session == nil {
		return nil, errors.New("managed child control channel unavailable")
	}
	return b.session.control, nil
}
func ReadManagedSnapshot(ctx context.Context, root string) (entrypolicy.Snapshot, error) {
	c, e := pipeControl(root)
	if e != nil {
		return entrypolicy.Snapshot{}, e
	}
	return c.Snapshot(ctx)
}
func RevokeManagedAccount(ctx context.Context, root, account string) error {
	c, e := pipeControl(root)
	if e != nil {
		return e
	}
	return c.Revoke(ctx, account)
}
