package render

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode"

	"routeweaver/internal/domain"
)

// Optional inspection limits, not import/profile/publication limits. Larger
// published outputs remain usable; their node comparison is unavailable.
const MaxInspectedNodes = 10000
const maxInspectedArtifactBytes = 24 << 20
const maxInspectedDepth = 16

// A byte-small array can still expand into many Go values. This optional
// comparison budget is checked before any recursive value allocation.
const maxInspectedValues = 1_000_000

var ErrNodeInspectionUnavailable = errors.New("exported node comparison unavailable")

// InspectedNode is private comparison material, never an API representation.
// Unexported fields ensure accidental JSON serialization cannot expose secrets.
type InspectedNode struct {
	id, name string
	settings []byte
	secrets  []string
}

func (n InspectedNode) ID() string   { return n.id }
func (n InspectedNode) Name() string { return n.name }
func (n InspectedNode) SameSettings(other InspectedNode) bool {
	return bytes.Equal(n.settings, other.settings)
}
func (n InspectedNode) ProtectedStrings() []string { return append([]string(nil), n.secrets...) }

// InspectNodesOnly joins each emitted object to this artifact's own verified
// allocation. It never identifies endpoints by current/source display names.
func InspectNodesOnly(target Target, mode OutputMode, artifacts []domain.Artifact, allocations map[string]domain.NameAllocation) ([]InspectedNode, error) {
	fail := func() ([]InspectedNode, error) { return nil, ErrNodeInspectionUnavailable }
	if mode != NodesOnly || len(artifacts) != 1 || len(allocations) > MaxInspectedNodes {
		return fail()
	}
	root, path, nameKey := "", "", ""
	switch {
	case target.AdapterID == "mihomo" && target.Version == MihomoVersion:
		root, path, nameKey = "proxies", "mihomo-nodes.json", "name"
	case target.AdapterID == "sing-box" && target.Version == SingBoxVersion:
		root, path, nameKey = "outbounds", "sing-box-nodes.json", "tag"
	default:
		return fail()
	}
	a := artifacts[0]
	if a.Path != path || len(a.Content) > maxInspectedArtifactBytes {
		return fail()
	}
	names := map[string]string{}
	for id, allocation := range allocations {
		if !domain.ValidID(id) || !inspectionName(allocation.OutputName) || names[allocation.OutputName] != "" {
			return fail()
		}
		names[allocation.OutputName] = id
	}
	d := json.NewDecoder(strings.NewReader(a.Content))
	d.UseNumber()
	token := func(want any) bool { v, e := d.Token(); return e == nil && v == want }
	if !token(json.Delim('{')) || !token(root) || !token(json.Delim('[')) {
		return fail()
	}
	remainingValues := maxInspectedValues
	nodes := make([]InspectedNode, 0, len(allocations))
	seen := map[string]bool{}
	for d.More() {
		if len(nodes) >= len(allocations) || len(nodes) >= MaxInspectedNodes {
			return fail()
		}
		value, err := inspectionValue(d, 2, &remainingValues)
		if err != nil {
			return fail()
		}
		obj, ok := value.(map[string]any)
		if !ok {
			return fail()
		}
		name, ok := obj[nameKey].(string)
		if !ok || !inspectionName(name) {
			return fail()
		}
		id := names[name]
		if id == "" || seen[id] {
			return fail()
		}
		secrets, ok := inspectionNodeShape(target.AdapterID, obj)
		if !ok {
			return fail()
		}
		delete(obj, nameKey)
		canonical, err := json.Marshal(obj)
		if err != nil {
			return fail()
		}
		nodes = append(nodes, InspectedNode{id: id, name: name, settings: canonical, secrets: secrets})
		seen[id] = true
	}
	if !token(json.Delim(']')) || !token(json.Delim('}')) || len(nodes) != len(allocations) {
		return fail()
	}
	if _, err := d.Token(); err != io.EOF {
		return fail()
	}
	return nodes, nil
}
func inspectionName(s string) bool {
	if len(s) == 0 || len(s) > 240 || strings.TrimSpace(s) == "" {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Token walk rejects duplicate keys before canonicalization, bounded in depth
// and per-object shape. Only one node object is materialized at a time.
func inspectionValue(d *json.Decoder, depth int, remaining *int) (any, error) {
	if depth > maxInspectedDepth || *remaining <= 0 {
		return nil, ErrNodeInspectionUnavailable
	}
	*remaining--
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t {
	case json.Delim('{'):
		m := map[string]any{}
		for d.More() {
			if len(m) >= 32 {
				return nil, ErrNodeInspectionUnavailable
			}
			k, e := d.Token()
			if e != nil {
				return nil, e
			}
			key, ok := k.(string)
			if !ok {
				return nil, ErrNodeInspectionUnavailable
			}
			if _, exists := m[key]; exists {
				return nil, ErrNodeInspectionUnavailable
			}
			v, e := inspectionValue(d, depth+1, remaining)
			if e != nil {
				return nil, e
			}
			m[key] = v
		}
		end, e := d.Token()
		if e != nil || end != json.Delim('}') {
			return nil, ErrNodeInspectionUnavailable
		}
		return m, nil
	case json.Delim('['):
		a := []any{}
		for d.More() {
			v, e := inspectionValue(d, depth+1, remaining)
			if e != nil {
				return nil, e
			}
			a = append(a, v)
		}
		end, e := d.Token()
		if e != nil || end != json.Delim(']') {
			return nil, ErrNodeInspectionUnavailable
		}
		return a, nil
	default:
		if _, bad := t.(json.Delim); bad {
			return nil, ErrNodeInspectionUnavailable
		}
		return t, nil
	}
}
func keysOnly(m map[string]any, keys ...string) bool {
	for k := range m {
		found := false
		for _, allowed := range keys {
			if k == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func str(m map[string]any, k string, required bool) bool {
	v, ok := m[k]
	if !ok {
		return !required
	}
	_, ok = v.(string)
	return ok
}
func truth(m map[string]any, k string, required bool) bool {
	v, ok := m[k]
	if !ok {
		return !required
	}
	return v == true
}
func stringsArray(m map[string]any, k string) bool {
	v, ok := m[k]
	if !ok {
		return true
	}
	a, ok := v.([]any)
	if !ok {
		return false
	}
	for _, x := range a {
		if _, ok := x.(string); !ok {
			return false
		}
	}
	return true
}
func object(m map[string]any, k string) (map[string]any, bool) {
	v, ok := m[k].(map[string]any)
	return v, ok
}
func optionalStrings(m map[string]any, keys ...string) bool {
	for _, k := range keys {
		if !str(m, k, false) {
			return false
		}
	}
	return true
}
func present(m map[string]any, k string) bool { _, ok := m[k]; return ok }
func portValue(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	s := string(n)
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	p, e := strconv.Atoi(s)
	return e == nil && p >= 1 && p <= 65535
}
func headerShape(m map[string]any, k string) bool {
	if !present(m, k) {
		return true
	}
	h, ok := object(m, k)
	if !ok {
		return false
	}
	for _, value := range h {
		if _, ok := value.(string); !ok {
			return false
		}
	}
	return true
}

func inspectionNodeShape(adapter string, m map[string]any) ([]string, bool) {
	secrets := []string{}
	protect := func(o map[string]any, keys ...string) {
		for _, k := range keys {
			if v, ok := o[k].(string); ok && v != "" {
				secrets = append(secrets, v)
			}
		}
	}
	protectHeaders := func(o map[string]any) {
		if headers, ok := object(o, "headers"); ok {
			for key := range headers {
				if !strings.EqualFold(key, "Host") {
					protect(headers, key)
				}
			}
		}
	}
	name, port := "name", "port"
	if adapter == "sing-box" {
		name, port = "tag", "server_port"
	}
	if !str(m, name, true) || !str(m, "type", true) || !str(m, "server", true) || !portValue(m[port]) {
		return nil, false
	}
	kind := m["type"].(string)
	if (adapter == "mihomo" && kind == "socks5") || (adapter == "sing-box" && kind == "socks") {
		allowed := []string{name, "type", "server", port, "username", "password"}
		if adapter == "sing-box" {
			allowed = append(allowed, "version")
			if m["version"] != "5" {
				return nil, false
			}
		}
		if !keysOnly(m, allowed...) || !optionalStrings(m, "username", "password") || present(m, "username") != present(m, "password") {
			return nil, false
		}
		protect(m, "username", "password")
		return secrets, true
	}
	if (adapter == "mihomo" && kind == "ss") || (adapter == "sing-box" && kind == "shadowsocks") {
		method := "cipher"
		if adapter == "sing-box" {
			method = "method"
		}
		if !keysOnly(m, name, "type", "server", port, method, "password") || !str(m, method, true) || !str(m, "password", true) {
			return nil, false
		}
		protect(m, "password")
		return secrets, true
	}
	if adapter == "sing-box" && (kind == "hysteria2" || kind == "anytls") {
		tls, ok := object(m, "tls")
		if !ok || !keysOnly(m, name, "type", "server", port, "password", "tls") || !str(m, "password", true) || !keysOnly(tls, "enabled", "server_name", "alpn") || !truth(tls, "enabled", true) || !str(tls, "server_name", false) || !stringsArray(tls, "alpn") {
			return nil, false
		}
		protect(m, "password")
		return secrets, true
	}
	credential := "uuid"
	if kind == "trojan" {
		credential = "password"
	}
	if (kind != "vless" && kind != "trojan" && kind != "vmess") || !str(m, credential, true) {
		return nil, false
	}
	protect(m, credential)
	if adapter == "mihomo" {
		if kind == "vmess" {
			if m["alterId"] != json.Number("0") || !str(m, "cipher", true) || present(m, "flow") || present(m, "reality-opts") {
				return nil, false
			}
		} else if present(m, "alterId") || present(m, "cipher") {
			return nil, false
		}
		serverName := "servername"
		if kind == "trojan" {
			serverName = "sni"
			for _, k := range []string{"tls", "flow", "packet-encoding", "reality-opts"} {
				if present(m, k) {
					return nil, false
				}
			}
		}
		if !keysOnly(m, name, "type", "server", port, credential, "alterId", "cipher", "packet-encoding", "flow", "tls", serverName, "client-fingerprint", "alpn", "reality-opts", "network", "ws-opts", "grpc-opts") || !optionalStrings(m, "packet-encoding", "flow", serverName, "client-fingerprint", "network") || !truth(m, "tls", false) || !stringsArray(m, "alpn") {
			return nil, false
		}
		for _, k := range []string{"servername", "client-fingerprint", "alpn", "reality-opts"} {
			if kind != "trojan" && present(m, k) && !present(m, "tls") {
				return nil, false
			}
		}
		if present(m, "reality-opts") {
			r, ok := object(m, "reality-opts")
			if !ok || !keysOnly(r, "public-key", "short-id") || !str(r, "public-key", true) || !str(r, "short-id", true) {
				return nil, false
			}
			protect(r, "short-id")
		}
		network, _ := m["network"].(string)
		switch network {
		case "":
			if present(m, "network") || present(m, "ws-opts") || present(m, "grpc-opts") {
				return nil, false
			}
		case "tcp":
			if present(m, "ws-opts") || present(m, "grpc-opts") {
				return nil, false
			}
		case "ws":
			w, ok := object(m, "ws-opts")
			if !ok || present(m, "grpc-opts") || !keysOnly(w, "path", "headers", "v2ray-http-upgrade") || !str(w, "path", true) || !headerShape(w, "headers") || !truth(w, "v2ray-http-upgrade", false) {
				return nil, false
			}
			protectHeaders(w)
		case "grpc":
			g, ok := object(m, "grpc-opts")
			if !ok || present(m, "ws-opts") || !keysOnly(g, "grpc-service-name") || !str(g, "grpc-service-name", true) {
				return nil, false
			}
		default:
			return nil, false
		}
	} else {
		if kind == "vmess" {
			if m["alter_id"] != json.Number("0") || !str(m, "security", true) || present(m, "flow") {
				return nil, false
			}
			if tls, ok := object(m, "tls"); ok && present(tls, "reality") {
				return nil, false
			}
		} else if present(m, "alter_id") || present(m, "security") {
			return nil, false
		}
		if kind == "trojan" {
			if !present(m, "tls") || present(m, "flow") || present(m, "packet_encoding") {
				return nil, false
			}
			if tls, ok := object(m, "tls"); ok && present(tls, "reality") {
				return nil, false
			}
		}
		if !keysOnly(m, name, "type", "server", port, credential, "alter_id", "security", "packet_encoding", "flow", "tls", "transport") || !optionalStrings(m, "packet_encoding", "flow") {
			return nil, false
		}
		if present(m, "tls") {
			t, ok := object(m, "tls")
			if !ok || !keysOnly(t, "enabled", "server_name", "alpn", "utls", "reality") || !truth(t, "enabled", true) || !str(t, "server_name", false) || !stringsArray(t, "alpn") {
				return nil, false
			}
			if present(t, "utls") {
				u, ok := object(t, "utls")
				if !ok || !keysOnly(u, "enabled", "fingerprint") || !truth(u, "enabled", true) || !str(u, "fingerprint", true) {
					return nil, false
				}
			}
			if present(t, "reality") {
				r, ok := object(t, "reality")
				if !ok || !keysOnly(r, "enabled", "public_key", "short_id") || !truth(r, "enabled", true) || !str(r, "public_key", true) || !str(r, "short_id", true) {
					return nil, false
				}
				protect(r, "short_id")
			}
		}
		if present(m, "transport") {
			t, ok := object(m, "transport")
			if !ok || !str(t, "type", true) {
				return nil, false
			}
			switch t["type"] {
			case "ws":
				if !keysOnly(t, "type", "path", "headers") || !str(t, "path", true) || !headerShape(t, "headers") {
					return nil, false
				}
				protectHeaders(t)
			case "httpupgrade":
				if !keysOnly(t, "type", "path", "host", "headers") || !str(t, "path", true) || !str(t, "host", true) || !headerShape(t, "headers") {
					return nil, false
				}
				protectHeaders(t)
			case "grpc":
				if !keysOnly(t, "type", "service_name") || !str(t, "service_name", true) {
					return nil, false
				}
			default:
				return nil, false
			}
		}
	}
	return secrets, true
}
