package render

import (
	"fmt"
	"net/netip"
	"regexp"
	"routeweaver/internal/domain"
	"strconv"
	"strings"
)

// Native additions are composed with, never substituted for, managed identities.
// Group references are resolved against this already-authorized render only.
func composeNativePolicy(p domain.ClientProfileIR, target Target, base, patch map[string]any, ruleMode string) error {
	groupKey, nameKey, membersKey := "proxy-groups", "name", "proxies"
	names := map[string]bool{"DIRECT": true, "REJECT": true, "REJECT-DROP": true, "PASS": true, "COMPATIBLE": true, "GLOBAL": true}
	if target.AdapterID == "sing-box" {
		groupKey, nameKey, membersKey = "outbounds", "tag", "outbounds"
		names = map[string]bool{"rw-direct": true}
	}
	for _, allocation := range p.NameAllocations {
		names[allocation.OutputName] = true
	}
	added := map[string][]string{}
	if value, exists := patch[groupKey]; exists {
		groups, ok := value.([]any)
		if !ok {
			return nativeError("SCHEMA", "/"+groupKey, "expected an array of native groups")
		}
		for i, item := range groups {
			path := fmt.Sprintf("/%s/%d", groupKey, i)
			group, ok := item.(map[string]any)
			if !ok {
				return nativeError("SCHEMA", path, "expected a native group object")
			}
			name, ok := group[nameKey].(string)
			if !ok || strings.TrimSpace(name) == "" || len(name) > 200 || strings.ContainsAny(name, "\r\n,") {
				return nativeError("GROUP_NAME", path+"/"+nameKey, "use a nonempty unique name without commas or newlines")
			}
			if names[name] {
				return nativeError("IDENTITY_CONFLICT", path+"/"+nameKey, "native group name collides with a generated or native identity")
			}
			kind, _ := group["type"].(string)
			allowed := []string{"select", "url-test", "fallback", "load-balance"}
			if target.AdapterID == "sing-box" {
				allowed = []string{"selector", "urltest"}
			}
			if !has(allowed, kind) {
				return nativeError("PROTECTED_FIELD", path+"/type", "only native policy groups may be added; connections remain managed")
			}
			members, ok := group[membersKey].([]any)
			if !ok || len(members) == 0 {
				return nativeError("GROUP_MEMBERS", path+"/"+membersKey, "group must have explicit members")
			}
			for _, member := range members {
				s, ok := member.(string)
				if !ok {
					return nativeError("GROUP_MEMBERS", path+"/"+membersKey, "members must be names")
				}
				added[name] = append(added[name], s)
			}
			names[name] = true
		}
		for i, item := range groups {
			group := item.(map[string]any)
			for _, member := range added[group[nameKey].(string)] {
				if !names[member] {
					return nativeError("REFERENCE", fmt.Sprintf("/%s/%d/%s", groupKey, i, membersKey), "member is not a generated or native group/endpoint in this profile")
				}
			}
			if selected, ok := group["default"].(string); ok && !has(added[group[nameKey].(string)], selected) {
				return nativeError("REFERENCE", fmt.Sprintf("/%s/%d/default", groupKey, i), "default must name a member of this group")
			}
		}
		if nativeReferenceCycle(added) {
			return nativeError("GROUP_CYCLE", "/"+groupKey, "native groups form a reference cycle")
		}

		generated, _ := base[groupKey].([]any)
		base[groupKey] = append(generated, groups...)
		delete(patch, groupKey)
	}
	inbounds := map[string]bool{"rw-mixed": true}
	if p.Runtime.TUN != nil && p.Runtime.TUN.Enabled {
		inbounds["rw-tun"] = true
	}
	resources := map[string]bool{}
	for _, resource := range p.Resources {
		resources[resource.ID] = true
	}
	if target.AdapterID == "sing-box" {
		if err := validateSingBoxReferences(patch, "", names, resources, inbounds); err != nil {
			return err
		}
		if err := composeNativeDNS(base, patch); err != nil {
			return err
		}
	}
	ruleBase, rulePatch := base, patch
	rulePath := "/rules"
	if target.AdapterID == "sing-box" {
		ruleBase, _ = base["route"].(map[string]any)
		var ok bool
		rulePatch, ok = patch["route"].(map[string]any)
		if _, exists := patch["route"]; exists && !ok {
			return nativeError("SCHEMA", "/route", "expected route object")
		}
		rulePath = "/route/rules"
	}
	if value, exists := rulePatch["rules"]; exists {
		rules, ok := value.([]any)
		if !ok {
			return nativeError("SCHEMA", rulePath, "expected rule array")
		}
		for i, rule := range rules {
			path := fmt.Sprintf("%s/%d", rulePath, i)
			var err error
			if target.AdapterID == "mihomo" {
				err = validateMihomoNativeRule(rule, path, names, resources)
			} else {
				err = validateSingBoxReferences(rule, path, names, resources, inbounds)
			}
			if err != nil {
				return err
			}
		}
		generated, _ := ruleBase["rules"].([]any)
		var before, after []any
		if target.AdapterID == "mihomo" {
			after = generated[len(generated)-1:]
			generated = generated[:len(generated)-1]
		} else {
			if p.Runtime.Sniff {
				before = generated[:1]
				generated = generated[1:]
			}
			if p.DefaultAction.Kind == "reject" {
				after = generated[len(generated)-1:]
				generated = generated[:len(generated)-1]
			}
		}
		combined := append([]any{}, before...)
		switch ruleMode {
		case "prepend":
			combined = append(combined, rules...)
			combined = append(combined, generated...)
		case "append":
			combined = append(combined, generated...)
			combined = append(combined, rules...)
		case "replace":
			combined = append(combined, rules...)
		}
		ruleBase["rules"] = append(combined, after...)
		delete(rulePatch, "rules")
	}
	return nil
}

func validateSingBoxReferences(value any, path string, names, resources, inbounds map[string]bool) error {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			next := path + "/" + safeField(key)
			switch key {
			case "outbound", "detour":
				if s, ok := child.(string); !ok || !names[s] {
					return nativeError("REFERENCE", next, "outbound is not owned by this profile")
				}
			case "endpoint", "service", "netns", "certificate_provider", "preferred_by":
				return nativeError("REFERENCE", next, "unmanaged service/namespace references are unsupported")
			case "inbound":
				refs, ok := child.([]any)
				if !ok {
					refs = []any{child}
				}
				for _, ref := range refs {
					s, ok := ref.(string)
					if !ok || !inbounds[s] {
						return nativeError("REFERENCE", next, "inbound must name a generated listener in this profile")
					}
				}
			case "rule_set":
				refs, ok := child.([]any)
				if !ok {
					refs = []any{child}
				}
				for _, ref := range refs {
					s, ok := ref.(string)
					if !ok || !resources[s] {
						return nativeError("REFERENCE", next, "rule set must reference an owned structured resource")
					}
				}
			}
			if err := validateSingBoxReferences(child, next, names, resources, inbounds); err != nil {
				return err
			}
		}
	case []any:
		for i, child := range v {
			if err := validateSingBoxReferences(child, path+"/"+strconv.Itoa(i), names, resources, inbounds); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateMihomoNativeRule(value any, path string, names, resources map[string]bool) error {
	rule, ok := value.(string)
	if !ok {
		return nativeError("SCHEMA", path, "Mihomo rules must be native rule strings")
	}
	parts := strings.Split(rule, ",")
	if len(parts) < 3 || len(parts) > 4 {
		return nativeError("RULE_UNSUPPORTED", path, "use a supported native leaf rule; logical expressions remain structured")
	}
	kind, payload, action := parts[0], parts[1], parts[2]
	if payload == "" || strings.ContainsAny(payload, "\r\n") {
		return nativeError("RULE_SYNTAX", path, "rule predicate cannot be empty or multiline")
	}
	if !names[action] {
		return nativeError("REFERENCE", path, "action must reference a generated/native group, endpoint or builtin")
	}
	switch kind {
	case "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "PROCESS-NAME", "PROCESS-PATH", "PROCESS-NAME-WILDCARD", "PROCESS-PATH-WILDCARD":
	case "DOMAIN-REGEX", "PROCESS-NAME-REGEX", "PROCESS-PATH-REGEX":
		if _, err := regexp.Compile(payload); err != nil {
			return nativeError("RULE_SYNTAX", path, "invalid regular expression")
		}
	case "IP-CIDR", "IP-CIDR6", "SRC-IP-CIDR":
		if _, err := netip.ParsePrefix(payload); err != nil {
			return nativeError("RULE_SYNTAX", path, "invalid IP prefix")
		}
	case "DST-PORT", "SRC-PORT", "IN-PORT":
		for _, part := range strings.Split(payload, "/") {
			r := strings.Split(part, "-")
			if len(r) > 2 {
				return nativeError("RULE_SYNTAX", path, "invalid port range")
			}
			last := 0
			for _, v := range r {
				n, e := strconv.Atoi(v)
				if e != nil || n < 1 || n > 65535 || n < last {
					return nativeError("RULE_SYNTAX", path, "invalid port range")
				}
				last = n
			}
		}
	case "NETWORK":
		if !has([]string{"tcp", "udp"}, strings.ToLower(payload)) {
			return nativeError("RULE_SYNTAX", path, "network must be tcp or udp")
		}
	case "UID", "DSCP":
		n, err := strconv.ParseUint(payload, 10, 32)
		if err != nil || (kind == "DSCP" && n > 63) {
			return nativeError("RULE_SYNTAX", path, "invalid numeric predicate")
		}
	case "RULE-SET":
		if !resources[payload] {
			return nativeError("REFERENCE", path, "rule set must reference an owned structured resource")
		}
	default:
		return nativeError("RULE_UNSUPPORTED", path, "unsupported native rule type; file resources and logical rules remain structured")
	}
	if len(parts) == 4 && (parts[3] != "no-resolve" || !has([]string{"IP-CIDR", "IP-CIDR6", "RULE-SET"}, kind)) {
		return nativeError("RULE_SYNTAX", path, "unsupported native rule parameter")
	}
	return nil
}

// New DNS transports may be supplied natively, but generated resolver tags are
// stable and retained. References never fall through to another tenant/config.
func composeNativeDNS(base, patch map[string]any) error {
	generated, _ := base["dns"].(map[string]any)
	dns, ok := patch["dns"].(map[string]any)
	if _, exists := patch["dns"]; exists && !ok {
		return nativeError("SCHEMA", "/dns", "expected a DNS object")
	}
	known := map[string]bool{}
	servers, _ := generated["servers"].([]any)
	for _, item := range servers {
		if server, ok := item.(map[string]any); ok {
			if tag, ok := server["tag"].(string); ok {
				known[tag] = true
			}
		}
	}
	if value, exists := dns["servers"]; exists {
		extra, ok := value.([]any)
		if !ok {
			return nativeError("SCHEMA", "/dns/servers", "expected DNS server array")
		}
		for i, item := range extra {
			server, ok := item.(map[string]any)
			if !ok {
				return nativeError("SCHEMA", fmt.Sprintf("/dns/servers/%d", i), "expected DNS server object")
			}
			tag, ok := server["tag"].(string)
			if !ok || tag == "" {
				return nativeError("IDENTITY_CONFLICT", fmt.Sprintf("/dns/servers/%d/tag", i), "native DNS server requires a unique tag")
			}
			if known[tag] {
				return nativeError("IDENTITY_CONFLICT", fmt.Sprintf("/dns/servers/%d/tag", i), "native DNS tag collides with a generated or native resolver")
			}
			known[tag] = true
		}
		generated["servers"] = append(servers, extra...)
		delete(dns, "servers")
	}
	check := func(value any, path string) error {
		if object, ok := value.(map[string]any); ok {
			value = object["server"]
		}
		tag, ok := value.(string)
		if !ok || !known[tag] {
			return nativeError("REFERENCE", path, "DNS resolver must name a generated or native resolver in this profile")
		}
		return nil
	}
	if final, exists := dns["final"]; exists {
		if err := check(final, "/dns/final"); err != nil {
			return err
		}
	}
	var walk func(any, string, bool) error
	walk = func(value any, path string, rule bool) error {
		switch tree := value.(type) {
		case map[string]any:
			for key, child := range tree {
				next := path + "/" + safeField(key)
				if key == "domain_resolver" || key == "default_domain_resolver" || (rule && key == "server") {
					if err := check(child, next); err != nil {
						return err
					}
				}
				if err := walk(child, next, rule || key == "rules"); err != nil {
					return err
				}
			}
		case []any:
			for i, child := range tree {
				if err := walk(child, path+"/"+strconv.Itoa(i), rule); err != nil {
					return err
				}
			}
		}
		return nil
	}
	// Added server objects were removed from the patch; check the composed DNS
	// tree as well, without reading any certificate or hosts path it may contain.
	if err := walk(generated, "/dns", false); err != nil {
		return err
	}
	if err := walk(patch, "", false); err != nil {
		return err
	}
	dependencies := map[string][]string{}
	allServers, _ := generated["servers"].([]any)
	for _, item := range allServers {
		server, _ := item.(map[string]any)
		tag, _ := server["tag"].(string)
		resolver := server["domain_resolver"]
		if object, ok := resolver.(map[string]any); ok {
			resolver = object["server"]
		}
		if ref, ok := resolver.(string); ok {
			dependencies[tag] = append(dependencies[tag], ref)
		}
	}
	if nativeReferenceCycle(dependencies) {
		return nativeError("DNS_CYCLE", "/dns/servers", "DNS resolver dependencies form a cycle")
	}
	return nil
}

func nativeReferenceCycle(edges map[string][]string) bool {
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(name string) bool {
		if visiting[name] {
			return true
		}
		if visited[name] {
			return false
		}
		visiting[name] = true
		for _, next := range edges[name] {
			if visit(next) {
				return true
			}
		}
		visiting[name] = false
		visited[name] = true
		return false
	}
	for name := range edges {
		if visit(name) {
			return true
		}
	}
	return false
}
