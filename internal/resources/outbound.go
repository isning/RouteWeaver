package resources

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// ValidateHTTPSURL uses the same deny rules as untrusted resource fetching.
// Authentication belongs in a separate secret, not URL userinfo or query fields.
func ValidateHTTPSURL(raw string) error {
	f := New(Options{})
	u, err := f.parseURL(raw)
	if err != nil {
		return err
	}
	if u.RawQuery != "" || u.ForceQuery {
		return ErrURL
	}
	return nil
}

// PublicDialer resolves once, checks every address, and dials checked literal IPs.
// TLS callers must still verify the original hostname, never the literal dial IP.
func PublicDialer() func(context.Context, string, string) (net.Conn, error) {
	return New(Options{}).safeDial
}

// OutboundClient never consults environment proxies or follows redirects. A
// redirect must not forward a signed payload to an unapproved destination.
func OutboundClient(timeout time.Duration) *http.Client {
	if timeout <= 0 || timeout > 30*time.Second {
		timeout = 15 * time.Second
	}
	f := New(Options{Timeout: timeout})
	return &http.Client{Timeout: timeout, Transport: &outboundTransport{transport: &http.Transport{
		Proxy: nil, DialContext: f.safeDial, TLSHandshakeTimeout: 10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 32 << 10,
		DisableKeepAlives: true,
	}}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not allowed") }}
}

// PublicHostname validates the authority without resolving it. Dial-time checks
// remain mandatory because DNS can change after settings are saved.
func PublicHostname(host string) error {
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/\\@?#[] \t\r\n") {
		return ErrURL
	}
	if strings.Contains(host, ":") {
		if _, err := netip.ParseAddr(host); err != nil {
			return ErrURL
		}
	}

	u := &url.URL{Scheme: "https", Host: net.JoinHostPort(host, "443")}
	return ValidateHTTPSURL(u.String())
}

type outboundTransport struct{ transport *http.Transport }

func (t *outboundTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if err := ValidateHTTPSURL(r.URL.String()); err != nil {
		return nil, err
	}
	return t.transport.RoundTrip(r)
}
