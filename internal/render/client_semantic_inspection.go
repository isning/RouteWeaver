package render

import (
	"encoding/json"
	"io"
	"net/url"
	"strconv"
	"strings"

	"routeweaver/internal/domain"
)

// InspectFullConfigSecrets supplies private redaction context only. It does not
// reconstruct missing historical semantics or validate/apply a client config.
// Only the two exact portable emitters and their known node/group shapes are
// understood. Any unverified identity or credential-bearing shape fails closed.
func InspectFullConfigSecrets(target Target, artifacts []domain.Artifact, allocations map[string]domain.NameAllocation) ([]string, error) {
	fail := func() ([]string, error) { return nil, ErrNodeInspectionUnavailable }
	path, nameKey, nodesKey, groupsKey, direct := "", "", "", "", ""
	switch {
	case target.AdapterID == "mihomo" && target.Version == MihomoVersion:
		path, nameKey, nodesKey, groupsKey, direct = "mihomo.json", "name", "proxies", "proxy-groups", "DIRECT"
	case target.AdapterID == "sing-box" && target.Version == SingBoxVersion:
		path, nameKey, nodesKey, groupsKey, direct = "sing-box.json", "tag", "outbounds", "outbounds", "rw-direct"
	default:
		return fail()
	}
	if len(artifacts) != 1 || artifacts[0].Path != path || len(artifacts[0].Content) > maxInspectedArtifactBytes || len(allocations) > MaxInspectedNodes {
		return fail()
	}
	names := map[string]string{}
	for id, allocation := range allocations {
		if !domain.ValidID(id) || !inspectionName(allocation.OutputName) || allocation.OutputName == direct || names[allocation.OutputName] != "" {
			return fail()
		}
		names[allocation.OutputName] = id
	}
	d := json.NewDecoder(strings.NewReader(artifacts[0].Content))
	d.UseNumber()
	remaining := maxInspectedValues
	value, err := inspectionValue(d, 1, &remaining)
	if err != nil {
		return fail()
	}
	if _, err = d.Token(); err != io.EOF {
		return fail()
	}
	root, ok := value.(map[string]any)
	if !ok {
		return fail()
	}
	if target.AdapterID == "mihomo" {
		if !keysOnly(root, "mixed-port", "bind-address", "allow-lan", "mode", "log-level", "proxies", "proxy-groups", "rules", "rule-providers", "dns", "sniffer") {
			return fail()
		}
		if _, ok := root["rules"].([]any); !ok {
			return fail()
		}
	} else {
		if !keysOnly(root, "log", "inbounds", "outbounds", "route", "dns", "experimental") {
			return fail()
		}
		if _, ok := root["route"].(map[string]any); !ok {
			return fail()
		}
	}
	nodes, ok := root[nodesKey].([]any)
	if !ok || len(nodes) > MaxInspectedNodes+1 {
		return fail()
	}
	groups := []any{}
	if groupsKey != nodesKey {
		groups, ok = root[groupsKey].([]any)
		if !ok || len(groups) > MaxInspectedNodes {
			return fail()
		}
	}
	secrets := []string{}
	seen := map[string]bool{}
	seenDirect := false
	inspect := func(value any, group bool) bool {
		obj, ok := value.(map[string]any)
		if !ok {
			return false
		}
		name, ok := obj[nameKey].(string)
		if !ok || !inspectionName(name) {
			return false
		}
		kind, ok := obj["type"].(string)
		if !ok {
			return false
		}
		if target.AdapterID == "sing-box" && kind == "direct" {
			if group || name != direct || seenDirect || !keysOnly(obj, "type", "tag") {
				return false
			}
			seenDirect = true
			return true
		}
		if names[name] == "" || seen[name] {
			return false
		}
		if target.AdapterID == "sing-box" {
			group = kind == "selector" || kind == "urltest"
		}
		var protected []string
		if group {
			protected, ok = inspectionGroupSecrets(target.AdapterID, obj, names, direct)
		} else {
			protected, ok = inspectionNodeShape(target.AdapterID, obj)
		}
		if !ok {
			return false
		}
		secrets = append(secrets, protected...)
		seen[name] = true
		return true
	}
	for _, node := range nodes {
		if !inspect(node, false) {
			return fail()
		}
	}
	for _, group := range groups {
		if !inspect(group, true) {
			return fail()
		}
	}
	if len(seen) != len(allocations) || target.AdapterID == "sing-box" && !seenDirect {
		return fail()
	}
	return secrets, nil
}

func inspectionGroupSecrets(adapter string, obj map[string]any, names map[string]string, direct string) ([]string, bool) {
	nameKey, membersKey := "name", "proxies"
	if adapter == "sing-box" {
		nameKey, membersKey = "tag", "outbounds"
	}
	if !str(obj, nameKey, true) || !str(obj, "type", true) {
		return nil, false
	}
	kind := obj["type"].(string)
	manual, test, balance := kind == "select", kind == "url-test", kind == "load-balance"
	if adapter == "sing-box" {
		manual, test, balance = kind == "selector", kind == "urltest", false
	}
	if !manual && !test && !balance && !(adapter == "mihomo" && kind == "fallback") {
		return nil, false
	}
	allowed := []string{nameKey, "type", membersKey}
	if !manual {
		allowed = append(allowed, "url", "interval")
	}
	if test {
		allowed = append(allowed, "tolerance")
	}
	if balance {
		allowed = append(allowed, "strategy")
	}
	if !keysOnly(obj, allowed...) {
		return nil, false
	}
	members, ok := obj[membersKey].([]any)
	if !ok || len(members) == 0 || len(members) > MaxInspectedNodes {
		return nil, false
	}
	seen := map[string]bool{}
	for _, value := range members {
		member, ok := value.(string)
		if !ok || seen[member] || member != direct && names[member] == "" {
			return nil, false
		}
		seen[member] = true
	}
	if manual {
		return nil, true
	}
	if !str(obj, "url", true) {
		return nil, false
	}
	u, err := url.Parse(obj["url"].(string))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, false
	}
	if adapter == "sing-box" {
		interval, ok := obj["interval"].(string)
		if !ok || !strings.HasSuffix(interval, "s") {
			return nil, false
		}
		if n, err := strconv.ParseUint(strings.TrimSuffix(interval, "s"), 10, 64); err != nil || n == 0 {
			return nil, false
		}
	} else if !inspectionNonnegativeInteger(obj["interval"], true) {
		return nil, false
	}
	if test && !inspectionNonnegativeInteger(obj["tolerance"], false) {
		return nil, false
	}
	if balance {
		strategy, _ := obj["strategy"].(string)
		if strategy != "round-robin" && strategy != "consistent-hashing" && strategy != "sticky-sessions" {
			return nil, false
		}
	}
	// Test URLs are not API fields, but query/fragment tokens may have been used
	// as a display name. Protect them across old and new artifacts as well.
	protected := []string{}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, false
	}
	for _, values := range query {
		for _, value := range values {
			if value != "" {
				protected = append(protected, value)
			}
		}
	}
	if u.Fragment != "" {
		protected = append(protected, u.Fragment)
	}
	return protected, true
}

func inspectionNonnegativeInteger(value any, positive bool) bool {
	n, ok := value.(json.Number)
	if !ok {
		return false
	}
	parsed, err := strconv.ParseUint(string(n), 10, 64)
	return err == nil && (!positive || parsed > 0)
}
