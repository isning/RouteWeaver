package managedxray

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"routeweaver/internal/entrypolicy"
)

// DestinationResolver resolves ultimate destinations, not administrator-declared
// transit connectors. Its result is validated once and passed to native as an IP.
type DestinationResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

func ValidateDestinationPolicy(policy entrypolicy.DestinationPolicy) error {
	if len(policy.AllowCIDRs) > 128 {
		return errors.New("too many destination grants")
	}
	seen := map[netip.Prefix]bool{}
	for _, raw := range policy.AllowCIDRs {
		p, err := netip.ParsePrefix(raw)
		if err != nil || p.Bits() == 0 || p.Addr().Is4In6() || p != p.Masked() || p.String() != raw || seen[p] {
			return errors.New("destination grants must be unique canonical non-default CIDRs")
		}
		seen[p] = true
	}
	return nil
}

// These conservative exclusions include private, shared, loopback, link-local,
// documentation, benchmarking, protocol-assignment and transition ranges. IPv6
// reviewed against IANA special-purpose registries on 2026-10-19:
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
// IPv6 is otherwise limited to allocated global-unicast 2000::/3, not IsGlobalUnicast
// alone (which also returns true for private and documentation addresses).
var nonPublicDestinations = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.31.196.0/24"), netip.MustParsePrefix("192.52.193.0/24"),
	netip.MustParsePrefix("192.175.48.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"), netip.MustParsePrefix("2620:4f:8000::/48"),
}
var globalV6 = netip.MustParsePrefix("2000::/3")

func destinationAllowed(ip netip.Addr, policy entrypolicy.DestinationPolicy) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	// Never send TCP payload to unspecified or multicast, even under an explicit
	// private-network grant. Loopback/private unicast exceptions remain possible.
	if ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, raw := range policy.AllowCIDRs {
		p, _ := netip.ParsePrefix(raw)
		if p.Contains(ip) {
			return true
		}
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || (ip.Is6() && !globalV6.Contains(ip)) {
		return false
	}
	for _, p := range nonPublicDestinations {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// ResolveDestination is the public policy seam. It rejects the whole DNS answer
// set if any address is unsafe, pins one approved IP, and preserves the original
// domain only as a routing hint. No caller-owned session metadata is mutated.
func ResolveDestination(ctx context.Context, dst xnet.Destination, policy entrypolicy.DestinationPolicy, resolver DestinationResolver) (context.Context, xnet.Destination, error) {
	deny := func() (context.Context, xnet.Destination, error) {
		return ctx, xnet.Destination{}, errors.New("ultimate destination is not permitted")
	}
	if err := ValidateDestinationPolicy(policy); err != nil {
		return ctx, xnet.Destination{}, err
	}
	if dst.Network != xnet.Network_TCP || dst.Address == nil || dst.Port == 0 {
		return deny()
	}
	if err := ctx.Err(); err != nil {
		return ctx, xnet.Destination{}, err
	}
	original := dst
	if dst.Address.Family().IsDomain() {
		host := dst.Address.Domain()
		if !validDestinationDomain(host) {
			return deny()
		}
		if resolver == nil {
			resolver = net.DefaultResolver
		}
		lookup, cancel := context.WithTimeout(ctx, 2*time.Second)
		addresses, err := resolver.LookupNetIP(lookup, "ip", host)
		if err == nil {
			err = lookup.Err()
		}
		cancel()
		if err != nil || len(addresses) == 0 || len(addresses) > 64 {
			return deny()
		}
		for _, ip := range addresses {
			if !destinationAllowed(ip, policy) {
				return deny()
			}
		}
		dst.Address = xnet.IPAddress(addresses[0].Unmap().AsSlice())
	} else if dst.Address.Family().IsIP() {
		ip, ok := netip.AddrFromSlice(dst.Address.IP())
		if !ok || !destinationAllowed(ip, policy) {
			return deny()
		}
		dst.Address = xnet.IPAddress(ip.Unmap().AsSlice())
	} else {
		return deny()
	}
	previous := session.OutboundsFromContext(ctx)
	copied := make([]*session.Outbound, len(previous))
	for i, old := range previous {
		copied[i] = new(session.Outbound)
		if old != nil {
			*copied[i] = *old
		}
	}
	if len(copied) == 0 {
		copied = []*session.Outbound{{}}
	}
	if original.Address.Family().IsDomain() {
		copied[len(copied)-1].RouteTarget = original
	}
	return session.ContextWithOutbounds(ctx, copied), dst, nil
}
func validDestinationDomain(host string) bool {
	if len(host) > 253 || host == "" {
		return false
	}
	host = strings.TrimSuffix(host, ".")
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}
