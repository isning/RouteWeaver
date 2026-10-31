package managedxray_test

import (
	"context"
	"net/netip"
	"testing"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

type answerResolver struct {
	calls   int
	answers []netip.Addr
}

func (r *answerResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls++
	return r.answers, nil
}
func TestDestinationPolicyDeniesPrivateSpecialAndUnsupportedTargets(t *testing.T) {
	for _, ip := range []string{"0.0.0.0", "10.0.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.0.0.8", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"} {
		t.Run(ip, func(t *testing.T) {
			_, _, err := managed.ResolveDestination(context.Background(), xnet.TCPDestination(xnet.ParseAddress(ip), 443), entrypolicy.DestinationPolicy{}, nil)
			if err == nil {
				t.Fatal("unsafe ultimate destination accepted")
			}
		})
	}
	for _, ip := range []string{"9.9.9.9", "2606:4700:4700::1111"} {
		_, dst, err := managed.ResolveDestination(context.Background(), xnet.TCPDestination(xnet.ParseAddress(ip), 443), entrypolicy.DestinationPolicy{}, nil)
		if err != nil || dst.Address.IP().String() != ip {
			t.Fatalf("public destination rejected: %v", err)
		}
	}
	if _, _, err := managed.ResolveDestination(context.Background(), xnet.UDPDestination(xnet.ParseAddress("9.9.9.9"), 53), entrypolicy.DestinationPolicy{}, nil); err == nil {
		t.Fatal("untested UDP accepted")
	}
}
func TestDestinationResolutionChecksEveryAnswerAndPinsWithoutMutatingRoutingContext(t *testing.T) {
	domain := xnet.TCPDestination(xnet.DomainAddress("example.invalid"), 443)
	resolver := &answerResolver{answers: []netip.Addr{netip.MustParseAddr("9.9.9.9"), netip.MustParseAddr("127.0.0.1")}}
	if _, _, err := managed.ResolveDestination(context.Background(), domain, entrypolicy.DestinationPolicy{}, resolver); err == nil {
		t.Fatal("mixed public/private DNS answer accepted")
	}
	resolver.calls = 0
	original := []*session.Outbound{{Tag: "previous"}, {Tag: "chosen"}}
	ctx := session.ContextWithOutbounds(context.Background(), original)
	policy := entrypolicy.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	next, pinned, err := managed.ResolveDestination(ctx, domain, policy, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if resolver.calls != 1 || pinned.Address.String() != "9.9.9.9" {
		t.Fatalf("not resolved exactly once and pinned: %v %v", resolver.calls, pinned)
	}
	cloned := session.OutboundsFromContext(next)
	if len(cloned) != 2 || cloned[1].RouteTarget.Address.Domain() != "example.invalid" {
		t.Fatal("original domain routing intent lost")
	}
	cloned[0].Tag = "changed"
	if original[0].Tag != "previous" || original[1].RouteTarget.Address != nil {
		t.Fatal("caller routing metadata mutated")
	}
}
func TestDestinationPolicyRequiresCanonicalSpecificAdministratorGrants(t *testing.T) {
	for _, cidrs := range [][]string{{"0.0.0.0/0"}, {"::/0"}, {"127.0.0.1/8"}, {"127.0.0.1/32", "127.0.0.1/32"}, {"invalid"}, {"::ffff:127.0.0.1/128"}} {
		if err := managed.ValidateDestinationPolicy(entrypolicy.DestinationPolicy{AllowCIDRs: cidrs}); err == nil {
			t.Fatalf("invalid grant accepted: %v", cidrs)
		}
	}
	p := entrypolicy.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	if _, _, err := managed.ResolveDestination(context.Background(), xnet.TCPDestination(xnet.ParseAddress("127.0.0.1"), 443), p, nil); err != nil {
		t.Fatal("explicit synthetic loopback grant rejected", err)
	}
}
