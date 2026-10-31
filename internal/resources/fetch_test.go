package resources

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"routeweaver/internal/domain"
	"strings"
	"sync"
	"testing"
)

func TestFetchRejectsSpecialAddressesBeforeDial(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "192.0.2.3", "198.18.1.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1"} {
		t.Run(raw, func(t *testing.T) {
			f := New(Options{})
			f.dial = func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("unsafe address reached dial")
				return nil, ErrFetch
			}
			_, err := f.Fetch(context.Background(), "https://"+net.JoinHostPort(raw, "443")+"/resource")
			if !errors.Is(err, ErrAddress) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestFetchRejectsUnsafeURLs(t *testing.T) {
	f := New(Options{})
	f.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("unsafe URL reached dial")
		return nil, ErrFetch
	}
	for _, raw := range []string{"file:///etc/passwd", "http://example.com", "https://a:b@example.com", "https://localhost", "https://x.local", "https://x.internal", "https://example.com#secret", "https://example.com:0", "https://example.com:70000"} {
		if _, err := f.Fetch(context.Background(), raw); !errors.Is(err, ErrURL) {
			t.Errorf("accepted %q: %v", raw, err)
		}
	}
}

// net.Pipe keeps tests offline and exercises the real HTTP client/transport,
// redirects, request serialization and body bounds rather than a mocked Fetch.
func fixtureFetcher(t *testing.T, response func(*http.Request) string) (*Fetcher, *[]string) {
	t.Helper()
	f := New(Options{AllowHTTP: true, MaxBytes: 32})
	dialed := []string{}
	var mu sync.Mutex
	f.lookup = func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host == "private.example" {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}
	f.dial = func(_ context.Context, _, address string) (net.Conn, error) {
		mu.Lock()
		dialed = append(dialed, address)
		mu.Unlock()
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			req, err := http.ReadRequest(bufio.NewReader(server))
			if err == nil {
				io.WriteString(server, response(req))
			}
		}()
		return client, nil
	}
	return f, &dialed
}
func TestFetchPublicPinnedAndDigest(t *testing.T) {
	f, dialed := fixtureFetcher(t, func(req *http.Request) string {
		if req.Host != "public.example" {
			t.Errorf("host lost: %s", req.Host)
		}
		return "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello"
	})
	result, err := f.Fetch(context.Background(), "http://public.example/sub?token=secret")
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Body) != "hello" || len(result.SHA256) != 64 || result.MediaType != "text/plain" {
		t.Fatalf("bad result %+v", result)
	}
	if len(*dialed) != 1 || (*dialed)[0] != "93.184.216.34:80" {
		t.Fatalf("not pinned: %v", *dialed)
	}
}
func TestRedirectCannotReachPrivate(t *testing.T) {
	f, dialed := fixtureFetcher(t, func(*http.Request) string {
		return "HTTP/1.1 302 Found\r\nLocation: http://private.example/secret\r\nContent-Length: 0\r\n\r\n"
	})
	_, err := f.Fetch(context.Background(), "http://public.example/sub?token=secret")
	if !errors.Is(err, ErrAddress) {
		t.Fatalf("got %v", err)
	}
	if len(*dialed) != 1 {
		t.Fatal("private destination dialed")
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatal("URL secret exposed")
	}
}
func TestMixedDNSAnswersDeniedBeforeDial(t *testing.T) {
	f, dialed := fixtureFetcher(t, func(*http.Request) string { return "" })
	f.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.1")}, nil
	}
	_, err := f.Fetch(context.Background(), "http://public.example")
	if !errors.Is(err, ErrAddress) || len(*dialed) != 0 {
		t.Fatalf("unsafe mixed DNS: %v %v", err, *dialed)
	}
}
func TestBodySizeAndHTTPError(t *testing.T) {
	for _, test := range []struct {
		name, wire string
		want       error
	}{{"length", "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n", ErrTooLarge}, {"stream", "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + strings.Repeat("x", 33), ErrTooLarge}, {"status", "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", ErrFetch}} {
		t.Run(test.name, func(t *testing.T) {
			f, _ := fixtureFetcher(t, func(*http.Request) string { return test.wire })
			_, err := f.Fetch(context.Background(), "http://public.example")
			if !errors.Is(err, test.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestTransportErrorRedactsSecret(t *testing.T) {
	f := New(Options{AllowHTTP: true})
	f.lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return nil, fmt.Errorf("sensitive diagnostic")
	}
	_, err := f.Fetch(context.Background(), "http://public.example?token=topsecret")
	if err != ErrFetch {
		t.Fatalf("unredacted: %v", err)
	}
}

func TestRedirectDoesNotForwardReferrer(t *testing.T) {
	f, _ := fixtureFetcher(t, func(req *http.Request) string {
		if req.URL.Path == "/start" {
			return "HTTP/1.1 302 Found\r\nLocation: http://next.example/end\r\nContent-Length: 0\r\n\r\n"
		}
		if req.Header.Get("Referer") != "" {
			t.Error("subscription URL leaked in redirect referrer")
		}
		return "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
	})
	result, err := f.Fetch(context.Background(), "http://public.example/start?token=private")
	if err != nil || string(result.Body) != "ok" {
		t.Fatalf("redirect failed %v", err)
	}
}
func TestRedirectLoopIsBounded(t *testing.T) {
	f, dialed := fixtureFetcher(t, func(*http.Request) string {
		return "HTTP/1.1 302 Found\r\nLocation: http://public.example/loop\r\nContent-Length: 0\r\n\r\n"
	})
	_, err := f.Fetch(context.Background(), "http://public.example/loop")
	if !errors.Is(err, ErrURL) || len(*dialed) > 5 {
		t.Fatalf("redirect limit failed %v %d", err, len(*dialed))
	}
}

func TestFetchRuleFileRejectsChangedBytesBehindPin(t *testing.T) {
	body := `{"version":5,"rules":[{"domain":["old.example"]}]}`
	f, _ := fixtureFetcher(t, func(*http.Request) string {
		return fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	})
	f.options.MaxBytes = MaxRuleFileBytes
	request := domain.RuleResource{ID: "pinned", OwnerID: "owner", Format: "sing-box-source", UpdatePolicy: "pinned"}
	accepted, err := f.FetchRuleFile(context.Background(), "http://public.example/file?token=synthetic", request)
	if err != nil {
		t.Fatal(err)
	}
	body = `{"version":5,"rules":[{"domain":["changed.example"]}]}`
	if _, err = f.FetchRuleFile(context.Background(), "http://public.example/file?token=synthetic", accepted.Resource); err == nil {
		t.Fatal("mutable URL replaced pinned accepted bytes")
	}
	body = "<html>gateway failed</html>"
	request.Digest = ""
	if _, err = f.FetchRuleFile(context.Background(), "http://public.example/file?token=synthetic", request); err == nil {
		t.Fatal("HTML response accepted as rule source")
	}
}
