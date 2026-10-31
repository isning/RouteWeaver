// Package resources retrieves untrusted subscription and rule resources without
// allowing an import URL to become access to the control plane's private network.
package resources

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrURL      = errors.New("resource URL is not allowed")
	ErrAddress  = errors.New("resource address is not public")
	ErrFetch    = errors.New("resource could not be fetched")
	ErrTooLarge = errors.New("resource exceeds size limit")
)

// Options are operator configuration, never supplied directly by an import form.
// Zero values select a 16 MiB body limit and a 30 second total request timeout.
type Options struct {
	MaxBytes  int64
	Timeout   time.Duration
	AllowHTTP bool
}
type Result struct {
	Body      []byte
	MediaType string
	SHA256    string
}
type lookupFunc func(context.Context, string, string) ([]netip.Addr, error)
type dialFunc func(context.Context, string, string) (net.Conn, error)

type Fetcher struct {
	options Options
	lookup  lookupFunc
	dial    dialFunc
}

func New(opts Options) *Fetcher {
	if opts.MaxBytes <= 0 || opts.MaxBytes > 64<<20 {
		opts.MaxBytes = 16 << 20
	}
	if opts.Timeout <= 0 || opts.Timeout > 2*time.Minute {
		opts.Timeout = 30 * time.Second
	}
	return &Fetcher{options: opts, lookup: net.DefaultResolver.LookupNetIP, dial: (&net.Dialer{Timeout: 10 * time.Second}).DialContext}
}

// Fetch never returns transport errors containing the source URL: subscription
// URLs often contain bearer secrets. The caller owns tenant-private storage.
func (f *Fetcher) Fetch(ctx context.Context, rawURL string) (Result, error) {
	u, err := f.parseURL(rawURL)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, f.options.Timeout)
	defer cancel()
	transport := &http.Transport{Proxy: nil, DialContext: f.safeDial, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 64 << 10, DisableKeepAlives: true, ForceAttemptHTTP2: false}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return ErrURL
		}
		if _, err := f.parseURL(req.URL.String()); err != nil {
			return err
		}
		if len(via) > 0 && via[len(via)-1].URL.Scheme == "https" && req.URL.Scheme != "https" {
			return ErrURL
		}
		req.Header.Del("Referer")
		req.Header.Del("Authorization")
		req.Header.Del("Cookie")
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Result{}, ErrURL
	}
	req.Header.Set("User-Agent", "RouteWeaver/1")
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		for _, known := range []error{ErrURL, ErrAddress} {
			if errors.Is(err, known) {
				return Result{}, known
			}
		}
		return Result{}, ErrFetch
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("%w (HTTP %d)", ErrFetch, response.StatusCode)
	}
	if response.ContentLength > f.options.MaxBytes {
		return Result{}, ErrTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, f.options.MaxBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, ErrFetch
	}
	if int64(len(body)) > f.options.MaxBytes {
		return Result{}, ErrTooLarge
	}
	sum := sha256.Sum256(body)
	return Result{Body: body, MediaType: response.Header.Get("Content-Type"), SHA256: hex.EncodeToString(sum[:])}, nil
}

func (f *Fetcher) parseURL(raw string) (*url.URL, error) {
	if len(raw) > 8192 {
		return nil, ErrURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.Hostname() == "" || (u.Scheme != "https" && !(u.Scheme == "http" && f.options.AllowHTTP)) {
		return nil, ErrURL
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if strings.ContainsAny(host, "%\\ \t\n\r") || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, ErrURL
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, ErrURL
		}
	}
	if addr, err := netip.ParseAddr(host); err == nil && !publicAddress(addr) {
		return nil, ErrAddress
	}
	return u, nil
}

// DNS resolution and dialing share the checked literal IP. The transport never
// resolves the hostname a second time, so DNS rebinding cannot swap the target.
func (f *Fetcher) safeDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrAddress
	}
	addresses, err := f.resolvePublic(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, addr := range addresses {
		conn, err := f.dial(ctx, network, net.JoinHostPort(addr.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, ErrFetch
}

var excluded = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

func publicAddress(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	// Only currently allocated IPv6 global unicast; excludes NAT64/IPv4-compatible
	// encodings and special-use prefixes that could hide a private IPv4 target.
	if addr.Is6() && !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return false
	}
	for _, prefix := range excluded {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

// ResolvePublicAddresses shares the resource-fetch policy for callers which dial
// through an already authorized native route. The caller must use a returned
// literal address, never resolve the hostname again at a downstream proxy.
func ResolvePublicAddresses(ctx context.Context, host string) ([]netip.Addr, error) {
	return New(Options{}).resolvePublic(ctx, host)
}
func (f *Fetcher) resolvePublic(ctx context.Context, host string) ([]netip.Addr, error) {
	addresses, err := f.lookup(ctx, "ip", host)
	if err != nil || len(addresses) == 0 || len(addresses) > 64 {
		return nil, ErrFetch
	}
	for _, addr := range addresses {
		if !publicAddress(addr) {
			return nil, ErrAddress
		}
	}
	return addresses, nil
}
