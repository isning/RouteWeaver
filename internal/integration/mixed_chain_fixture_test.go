//go:build linux

package integration_test

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These servers are independent wire peers, not mocked native-core dialers.
// A proxy can only reach its one literal loopback successor. No hostname is
// resolved, subscription is imported, or external service is contacted.
type mixedWireStats struct {
	Accepted, Authenticated, RejectedAuth, Connected, RejectedTarget int
	Upload, Download                                                 int64
	Target                                                           string
}

type mixedWireServer struct {
	listener    net.Listener
	mu          sync.Mutex
	stats       mixedWireStats
	connections map[net.Conn]bool
	acceptDone  chan struct{}
	serving     sync.WaitGroup
	closeOnce   sync.Once
}

func mixedListen(t *testing.T) *mixedWireServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &mixedWireServer{listener: listener, connections: map[net.Conn]bool{}, acceptDone: make(chan struct{})}
	t.Cleanup(s.close)
	return s
}

func (s *mixedWireServer) start(handler func(net.Conn)) {
	go func() {
		defer close(s.acceptDone)
		for {
			conn, err := s.listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.stats.Accepted++
			s.connections[conn] = true
			s.mu.Unlock()
			s.serving.Add(1)
			go func() {
				defer s.serving.Done()
				defer conn.Close()
				defer func() { s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
				conn.SetDeadline(time.Now().Add(8 * time.Second))
				handler(conn)
			}()
		}
	}()
}

func (s *mixedWireServer) address() string { return s.listener.Addr().String() }
func (s *mixedWireServer) snapshot() mixedWireStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}
func (s *mixedWireServer) addBytes(upload bool, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if upload {
		s.stats.Upload += int64(n)
	} else {
		s.stats.Download += int64(n)
	}
}
func (s *mixedWireServer) close() {
	s.closeOnce.Do(func() {
		s.listener.Close()
		<-s.acceptDone // No more serving.Add calls can race with Wait.
		s.mu.Lock()
		for conn := range s.connections {
			conn.Close()
		}
		s.mu.Unlock()
		s.serving.Wait()
	})
}

func mixedEchoTarget(t *testing.T) *mixedWireServer {
	t.Helper()
	s := mixedListen(t)
	s.start(func(conn net.Conn) {
		buffer := make([]byte, 4096)
		for {
			n, err := conn.Read(buffer)
			if n > 0 {
				s.addBytes(true, n)
				written, writeErr := conn.Write(buffer[:n])
				s.addBytes(false, written)
				if writeErr != nil || written != n {
					return
				}
			}
			if err != nil {
				return
			}
		}
	})
	return s
}

type mixedSOCKSPeer struct {
	*mixedWireServer
	username, password, next string
	rejectAuth               atomic.Bool
}

func mixedSOCKSProxy(t *testing.T, next string, ordinal int) *mixedSOCKSPeer {
	t.Helper()
	host, port, err := net.SplitHostPort(next)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || port == "0" {
		t.Fatal("external fixture successor must be a literal loopback address")
	}
	p := &mixedSOCKSPeer{mixedWireServer: mixedListen(t), username: fmt.Sprintf("synthetic-%d", ordinal), password: fmt.Sprintf("loopback-only-%d", ordinal), next: next}
	p.start(p.serve)
	return p
}

func (p *mixedSOCKSPeer) serve(conn net.Conn) {
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(conn, greeting); err != nil || greeting[0] != 5 || greeting[1] == 0 {
		return
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	authSupported := false
	for _, method := range methods {
		authSupported = authSupported || method == 2
	}
	if !authSupported {
		conn.Write([]byte{5, 255})
		return
	}
	if _, err := conn.Write([]byte{5, 2}); err != nil {
		return
	}
	if _, err := io.ReadFull(conn, greeting); err != nil || greeting[0] != 1 {
		return
	}
	username := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(conn, username); err != nil {
		return
	}
	length := make([]byte, 1)
	if _, err := io.ReadFull(conn, length); err != nil {
		return
	}
	password := make([]byte, int(length[0]))
	if _, err := io.ReadFull(conn, password); err != nil {
		return
	}
	if p.rejectAuth.Load() || string(username) != p.username || string(password) != p.password {
		p.mu.Lock()
		p.stats.RejectedAuth++
		p.mu.Unlock()
		conn.Write([]byte{1, 1})
		return
	}
	p.mu.Lock()
	p.stats.Authenticated++
	p.mu.Unlock()
	if _, err := conn.Write([]byte{1, 0}); err != nil {
		return
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 5 || header[1] != 1 || header[2] != 0 {
		return
	}
	var address []byte
	switch header[3] {
	case 1:
		address = make([]byte, 4)
	case 4:
		address = make([]byte, 16)
	default:
		// Deliberately do not resolve names, even if an implementation regresses.
		p.mu.Lock()
		p.stats.RejectedTarget++
		p.mu.Unlock()
		conn.Write([]byte{5, 8, 0, 1, 127, 0, 0, 1, 0, 0})
		return
	}
	if _, err := io.ReadFull(conn, address); err != nil {
		return
	}
	port := make([]byte, 2)
	if _, err := io.ReadFull(conn, port); err != nil {
		return
	}
	destination := net.JoinHostPort(net.IP(address).String(), strconv.Itoa(int(binary.BigEndian.Uint16(port))))
	p.mu.Lock()
	p.stats.Target = destination
	if destination != p.next {
		p.stats.RejectedTarget++
	}
	p.mu.Unlock()
	if destination != p.next {
		conn.Write([]byte{5, 2, 0, 1, 127, 0, 0, 1, 0, 0})
		return
	}
	upstream, err := net.DialTimeout("tcp", p.next, time.Second)
	if err != nil {
		conn.Write([]byte{5, 5, 0, 1, 127, 0, 0, 1, 0, 0})
		return
	}
	defer upstream.Close()
	upstream.SetDeadline(time.Now().Add(8 * time.Second))
	p.mu.Lock()
	p.stats.Connected++
	p.mu.Unlock()
	if _, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { mixedCopy(upstream, conn, p.mixedWireServer, true); done <- struct{}{} }()
	go func() { mixedCopy(conn, upstream, p.mixedWireServer, false); done <- struct{}{} }()
	<-done
	conn.Close()
	upstream.Close()
	<-done
}

func mixedCopy(destination net.Conn, source net.Conn, stats *mixedWireServer, upload bool) {
	buffer := make([]byte, 4096)
	for {
		n, err := source.Read(buffer)
		if n > 0 {
			written, writeErr := destination.Write(buffer[:n])
			stats.addBytes(upload, written)
			if writeErr != nil || written != n {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
