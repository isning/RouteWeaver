package render

import (
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"routeweaver/internal/domain"
)

// Mihomo's DNS fragments can otherwise silently reinterpret an unknown proxy
// name as a host interface. This subset requires explicit profile-owned policy
// references, a separate bootstrap resolver, and declared rule resources.
func validateMihomoNativeDNS(config map[string]any, resourceList []domain.RuleResource) error {
	dns, ok := config["dns"].(map[string]any)
	if !ok {
		return nil
	}
	names := map[string]bool{"DIRECT": true}
	for _, key := range []string{"proxies", "proxy-groups"} {
		items, _ := config[key].([]any)
		for _, item := range items {
			object, _ := item.(map[string]any)
			if name, ok := object["name"].(string); ok {
				names[name] = true
			}
		}
	}
	resources := map[string]bool{}
	for _, resource := range resourceList {
		resources[resource.ID] = true
	}
	bootstrap, _ := dns["proxy-server-nameserver"].([]any)
	if dns["respect-rules"] == true && len(bootstrap) == 0 {
		return nativeError("DNS_BOOTSTRAP", "/dns/proxy-server-nameserver", "DNS routing requires a separate proxy bootstrap resolver")
	}
	if dns["enable"] == true {
		servers, _ := dns["nameserver"].([]any)
		if len(servers) == 0 {
			return nativeError("SCHEMA", "/dns/nameserver", "enabled DNS needs at least one nameserver")
		}
	}
	if cidr, ok := dns["fake-ip-range"].(string); ok {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil || !prefix.Addr().Is4() {
			return nativeError("SCHEMA", "/dns/fake-ip-range", "fake-IP range must be an IPv4 prefix")
		}
	}
	for _, key := range []string{"nameserver", "fallback", "default-nameserver", "proxy-server-nameserver", "direct-nameserver"} {
		list, _ := dns[key].([]any)
		for i, item := range list {
			server, _ := item.(string)
			if err := validateMihomoDNSServer(server, fmt.Sprintf("/dns/%s/%d", key, i), key, names, len(bootstrap) > 0); err != nil {
				return err
			}
		}
	}
	if policy, ok := dns["nameserver-policy"].(map[string]any); ok {
		for selector, value := range policy {
			if err := validateMihomoDNSResource(selector, "/dns/nameserver-policy/[field]", resources); err != nil {
				return err
			}
			values, ok := value.([]any)
			if !ok {
				values = []any{value}
			}
			for _, v := range values {
				server, _ := v.(string)
				if err := validateMihomoDNSServer(server, "/dns/nameserver-policy/[field]", "nameserver-policy", names, len(bootstrap) > 0); err != nil {
					return err
				}
			}
		}
	}
	filter, _ := dns["fake-ip-filter"].([]any)
	for i, value := range filter {
		rule, _ := value.(string)
		path := fmt.Sprintf("/dns/fake-ip-filter/%d", i)
		if dns["fake-ip-filter-mode"] == "rule" {
			if rule == "MATCH,fake-ip" || rule == "MATCH,real-ip" {
				continue
			}
			if err := validateMihomoNativeRule(rule, path, map[string]bool{"fake-ip": true, "real-ip": true}, resources); err != nil {
				return err
			}
		} else if err := validateMihomoDNSResource(rule, path, resources); err != nil {
			return err
		}
	}
	// Implicit geodata downloads would bypass the explicit resource manifest.
	// Users can express these predicates using an owned domain rule provider.
	fallback, _ := dns["fallback"].([]any)
	fallbackFilter, _ := dns["fallback-filter"].(map[string]any)
	if fallbackFilter["geoip"] == true || (len(fallback) > 0 && fallbackFilter["geoip"] != false) {
		return nativeError("RESOURCE_CONFLICT", "/dns/fallback-filter/geoip", "disable implicit geodata and use explicit owned rule resources")
	}
	return nil
}
func validateMihomoDNSResource(selector, path string, resources map[string]bool) error {
	if strings.HasPrefix(selector, "geosite:") {
		return nativeError("RESOURCE_CONFLICT", path, "implicit geosite files are unsupported; reference an owned rule resource")
	}
	if strings.HasPrefix(selector, "rule-set:") {
		for _, ref := range strings.Split(strings.TrimPrefix(selector, "rule-set:"), ",") {
			if !resources[ref] {
				return nativeError("REFERENCE", path, "DNS rule set must reference an owned structured resource")
			}
		}
	}
	return nil
}
func validateMihomoDNSServer(server, path, field string, names map[string]bool, bootstrap bool) error {
	if server == "system" || server == "system://" {
		return nil
	}
	if _, err := netip.ParseAddr(server); err == nil {
		return nil
	}
	if !strings.Contains(server, "://") {
		server = "udp://" + server
	}
	parsed, err := url.Parse(server)
	if err != nil || !has([]string{"udp", "tcp", "tls", "https", "quic", "dhcp"}, parsed.Scheme) || parsed.Host == "" {
		return nativeError("DNS_SYNTAX", path, "unsupported DNS address or transport")
	}
	if parsed.User != nil {
		return nativeError("CREDENTIAL_FIELD", path, "DNS URL user information is not supported")
	}
	if field == "default-nameserver" {
		if _, err := netip.ParseAddr(parsed.Hostname()); err != nil {
			return nativeError("DNS_BOOTSTRAP", path, "default nameserver must use an IP literal")
		}
	}
	if port := parsed.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nativeError("DNS_SYNTAX", path, "invalid DNS port")
		}
	}
	if parsed.Fragment == "" {
		return nil
	}
	for _, option := range strings.Split(parsed.Fragment, "&") {
		key, value, assignment := strings.Cut(option, "=")
		switch key {
		case "h3", "skip-cert-verify", "ecs-override", "disable-ipv4", "disable-ipv6":
			if assignment && value != "true" && value != "false" {
				return nativeError("DNS_SYNTAX", path, "DNS option must be boolean")
			}
		case "ecs":
			if _, err := netip.ParsePrefix(value); err != nil {
				return nativeError("DNS_SYNTAX", path, "invalid DNS client subnet")
			}
		case "name-cert-verify":
			if !assignment || value == "" {
				return nativeError("DNS_SYNTAX", path, "DNS certificate name required")
			}
		default:
			if assignment || (!names[key] && key != "RULES") {
				return nativeError("REFERENCE", path, "DNS fragment must name an owned policy; implicit interface fallback is unsupported")
			}
			if key != "DIRECT" && (field == "proxy-server-nameserver" || field == "default-nameserver" || !bootstrap) {
				return nativeError("DNS_BOOTSTRAP", path, "proxied DNS needs a separate non-proxied bootstrap resolver")
			}
		}
	}
	return nil
}
