package httpapi

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"routeweaver/internal/auth"
	"strings"
	"time"
)

func parseTrustedProxies(values []string) ([]netip.Prefix, error) {
	out := []netip.Prefix{}
	for _, v := range values {
		p, e := netip.ParsePrefix(strings.TrimSpace(v))
		if e != nil {
			return nil, fmt.Errorf("trusted proxies must be explicit IP CIDRs")
		}
		if p.Bits() == 0 {
			return nil, fmt.Errorf("trusting every source as a proxy is not supported")
		}
		out = append(out, p.Masked())
	}
	return out, nil
}
func (h *server) trustedProxy(ip netip.Addr) bool {
	for _, p := range h.trustedProxies {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
func (h *server) authSource(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return "unknown-peer"
	}
	peer = peer.Unmap()
	if !h.trustedProxy(peer) {
		return peer.String()
	}
	// Walk from the socket peer backwards, stopping at the first untrusted hop.
	// A trusted proxy must overwrite XFF or append its observed peer, never relay
	// client input as an authoritative standalone value.
	values := r.Header.Values("X-Forwarded-For")
	if len(values) != 1 {
		return peer.String()
	}
	hops := strings.Split(values[0], ",")
	if len(hops) > 32 {
		return peer.String()
	}
	chain := make([]netip.Addr, len(hops))
	for i, raw := range hops {
		ip, e := netip.ParseAddr(strings.TrimSpace(raw))
		if e != nil {
			return peer.String()
		}
		chain[i] = ip.Unmap()
	}
	for i := len(chain) - 1; i >= 0; i-- {
		if !h.trustedProxy(peer) {
			break
		}
		peer = chain[i]
	}
	return peer.String()
}
func (h *server) allowLogin(r *http.Request) bool {
	p := current(r)
	purpose := "security"
	account := p.Account.ID
	if account == "" {
		purpose = "invite"
	}
	return h.allowAuth(r, purpose, account)
}
func (h *server) allowAuth(r *http.Request, purpose, account string) bool {
	source := h.authSource(r)
	account = strings.ToLower(strings.TrimSpace(account))
	// Separate anonymous login/invite and authenticated security budgets so an
	// unauthenticated attacker cannot exhaust an administrator's recovery actions.
	keys := []string{purpose + ":global", purpose + ":source:" + source, purpose + ":pair:" + source + ":" + auth.Digest(account)}
	limits := []int{1000, 200, 20}
	if account != "" {
		keys = append(keys, purpose+":account:"+auth.Digest(account))
		limits = append(limits, 100)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if len(h.attempts) >= 10000 {
		for k, v := range h.attempts {
			if !now.Before(v.Until) {
				delete(h.attempts, k)
			}
		}
	}
	missing := 0
	for _, key := range keys {
		if _, ok := h.attempts[key]; !ok {
			missing++
		}
	}
	if len(h.attempts)+missing > 10000 {
		return false
	}
	// Check every bucket before charging any, so rejected requests do not keep
	// unrelated users locked out by continually consuming a broad budget.
	for i, key := range keys {
		v := h.attempts[key]
		if now.Before(v.Until) && v.Count >= limits[i] {
			return false
		}
	}
	for _, key := range keys {
		v := h.attempts[key]
		if !now.Before(v.Until) {
			v = attempt{Until: now.Add(5 * time.Minute)}
		}
		v.Count++
		h.attempts[key] = v
	}
	return true
}
