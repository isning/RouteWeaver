//go:build linux

package main

import (
	"context"
	"net"
	"net/http"
	"syscall"
	"testing"
	"time"
)

func TestControlPlaneListenerUsesOrdinaryTCPDespiteAmbientMPTCP(t *testing.T) {
	for _, debug := range []string{"", "multipathtcp=1", "multipathtcp=0,multipathtcp=1"} {
		t.Run(debug, func(t *testing.T) {
			t.Setenv("GODEBUG", debug)
			config := controlPlaneTCPConfig()
			if config.MultipathTCP() {
				t.Fatal("listener requested MPTCP even if host would fall back")
			}
			l, err := listenControlPlane(context.Background(), "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			raw, err := l.(*net.TCPListener).SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			var protocol int
			var socketErr error
			if err = raw.Control(func(fd uintptr) {
				protocol, socketErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_PROTOCOL)
			}); err != nil || socketErr != nil {
				t.Fatal(err, socketErr)
			}
			if protocol != syscall.IPPROTO_TCP {
				t.Fatalf("control-plane listener protocol=%d, want ordinary TCP", protocol)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })}
			defer server.Close()
			go server.Serve(l)
			client := http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
			response, err := client.Get("http://" + l.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				t.Fatal(response.Status)
			}
		})
	}
}
