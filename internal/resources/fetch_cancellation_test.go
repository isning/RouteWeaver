package resources

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestFetchPreservesCancellationDuringBodyRead(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "caller cancellation"
		if deadline {
			name = "fetch timeout"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := New(Options{AllowHTTP: true, Timeout: time.Second})
			if deadline {
				f.options.Timeout = 30 * time.Millisecond
			}
			f.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}
			finished := make(chan struct{})
			f.dial = func(context.Context, string, string) (net.Conn, error) {
				client, server := net.Pipe()
				go func() {
					defer close(finished)
					defer server.Close()
					if _, err := http.ReadRequest(bufio.NewReader(server)); err != nil {
						return
					}
					// Make the headers and a partial body available, then leave the
					// real HTTP transport waiting for the rest of the response.
					if _, err := io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx"); err != nil {
						return
					}
					if !deadline {
						cancel()
					}
					_, _ = io.Copy(io.Discard, server)
				}()
				return client, nil
			}
			result, err := f.Fetch(ctx, "http://public.example/sub?token=synthetic-private")
			<-finished
			want := context.Canceled
			if deadline {
				want = context.DeadlineExceeded
			}
			if !errors.Is(err, want) {
				t.Fatalf("body interruption lost context classification: got %v, want %v", err, want)
			}
			if len(result.Body) != 0 || strings.Contains(err.Error(), "synthetic-private") {
				t.Fatal("interrupted fetch returned partial content or a private URL")
			}
		})
	}
}
