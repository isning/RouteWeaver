package resources_test

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/resources"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOutboundPolicyRejectsUnsafeDestinationAndIgnoresProxy(t *testing.T) {
	for _, url := range []string{"http://example.com/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.2/", "https://localhost/", "https://metadata.internal/", "https://user:secret@example.com/", "https://example.com/?secret=private", "https://example.com/#fragment"} {
		if e := resources.ValidateHTTPSURL(url); e == nil {
			t.Errorf("unsafe destination accepted: %s", url)
		}
	}
	if e := resources.ValidateHTTPSURL("https://notifications.example.com/events"); e != nil {
		t.Fatal(e)
	}
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	client := resources.OutboundClient(time.Second)
	request, _ := http.NewRequestWithContext(context.Background(), "POST", "https://127.0.0.1/events", nil)
	if response, e := client.Do(request); e == nil {
		response.Body.Close()
		t.Fatal("private destination accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("environment proxy used")
	}
	dial := resources.PublicDialer()
	if conn, e := dial(context.Background(), "tcp", net.JoinHostPort("127.0.0.1", "443")); e == nil {
		conn.Close()
		t.Fatal("public dialer reached private address")
	}
}

func TestOutboundClientDoesNotFollowRedirectOrForwardPayload(t *testing.T) {
	var received atomic.Int32
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", destination.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	client := resources.OutboundClient(time.Second)
	// Test-only TLS adapter reaches local fixture servers; production keeps the
	// public-DNS-pinned transport. Redirect policy remains the actual client policy.
	client.Transport = origin.Client().Transport
	request, _ := http.NewRequest("POST", origin.URL, strings.NewReader("synthetic private payload"))
	request.Header.Set("X-RouteWeaver-Signature", "synthetic-signature")
	if response, e := client.Do(request); e == nil {
		response.Body.Close()
		t.Fatal("redirect followed")
	}
	if received.Load() != 0 {
		t.Fatal("signed body forwarded to redirected destination")
	}
}
