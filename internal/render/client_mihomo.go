package render

import (
	"fmt"
	"net"
	"routeweaver/internal/domain"
	"strconv"
	"strings"
)

type MihomoClient struct{}

// Mihomo action syntax splits commas; a fullwidth comma is a readable,
// deterministic representation, and all references use the allocated name.
func (MihomoClient) NormalizeName(name string) string { return strings.ReplaceAll(name, ",", "，") }

func (MihomoClient) ClientCapability() ClientCapability {
	return ClientCapability{NativeOverride: nativeCapability("bounded-schema-and-references"), AdapterID: "mihomo", Versions: []string{MihomoVersion}, Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}, Groups: []string{"manual", "url-test", "fallback", "load-balance"}, MatchOps: []string{"domain", "domain-suffix", "ip-cidr", "resource", "and", "or", "not"}, ResourceFormats: []string{"mihomo-yaml", "mihomo-text", "mrs"}, Runtime: []string{"dns", "sniff"}, TLSFingerprints: []string{"chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq", "random"}, ReservedNames: []string{"DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"}}
}
func (MihomoClient) RenderClient(p domain.ClientProfileIR, _ Target, mode OutputMode, names map[string]string) (ClientResult, error) {
	semantics := newSemanticCapture(mode)
	proxies := []any{}
	for _, e := range p.Endpoints {
		if err := validateClientConnection(e.Connection, (MihomoClient{}).ClientCapability()); err != nil {
			return ClientResult{}, err
		}
		c := e.Connection
		proxy := map[string]any{"name": names[e.ID], "server": c.Host, "port": c.Port}
		switch c.Protocol {
		case "socks":
			proxy["type"] = "socks5"
			if c.Username != "" {
				proxy["username"] = c.Username
				proxy["password"] = c.Password
			}
		case "vless", "trojan", "vmess":
			proxy["type"] = c.Protocol
			if c.Protocol == "vmess" {
				proxy["alterId"] = 0
				proxy["cipher"] = vmessSecurity(c)
			}
			if c.Protocol == "trojan" {
				proxy["password"] = c.Password
			} else {
				proxy["uuid"] = c.UUID
			}
			if c.PacketEncoding != "" {
				proxy["packet-encoding"] = c.PacketEncoding
			}
			if c.Flow != "" {
				proxy["flow"] = c.Flow
			}
			if c.TLS != nil && c.TLS.Enabled {
				if c.Protocol != "trojan" {
					proxy["tls"] = true
				}
				if c.TLS.ServerName != "" {
					if c.Protocol == "trojan" {
						proxy["sni"] = c.TLS.ServerName
					} else {
						proxy["servername"] = c.TLS.ServerName
					}
				}
				if c.TLS.Fingerprint != "" {
					proxy["client-fingerprint"] = strings.ToLower(c.TLS.Fingerprint)
				}
				if len(c.TLS.ALPN) > 0 {
					proxy["alpn"] = c.TLS.ALPN
				}
				if c.TLS.Reality != nil {
					proxy["reality-opts"] = map[string]any{"public-key": c.TLS.Reality.PublicKey, "short-id": c.TLS.Reality.ShortID}
				}
			}
			if c.Transport != nil {
				tr := c.Transport
				proxy["network"] = tr.Type
				switch tr.Type {
				case "ws", "httpupgrade":
					proxy["network"] = "ws"
					opts := map[string]any{"path": tr.Path}
					if headers := transportHeaders(tr, true); len(headers) > 0 {
						opts["headers"] = headers
					}
					if tr.Type == "httpupgrade" {
						opts["v2ray-http-upgrade"] = true
					}
					proxy["ws-opts"] = opts
				case "grpc":
					proxy["grpc-opts"] = map[string]any{"grpc-service-name": tr.ServiceName}
				}
			}
		case "shadowsocks":
			proxy["type"] = "ss"
			proxy["cipher"] = c.Method
			proxy["password"] = c.Password
		}
		semantics.node("mihomo", e.ID, proxy)
		proxies = append(proxies, proxy)
	}
	if mode == NodesOnly {
		return clientResult("mihomo-nodes.json", map[string]any{"proxies": proxies}, p, names)
	}
	groups := []any{}
	for _, g := range p.Groups {
		kind := g.Kind
		if kind == "manual" {
			kind = "select"
		}
		members := []string{}
		resolved := domain.ResolveGroupMembers(g, p.Endpoints)
		for _, m := range resolved {
			members = append(members, actionName(m, names, "DIRECT", "REJECT"))
		}
		group := map[string]any{"name": names[g.ID], "type": kind, "proxies": members}
		if g.Kind != "manual" {
			group["url"] = g.TestURL
			group["interval"] = g.IntervalSeconds
		}
		if g.Kind == "url-test" {
			group["tolerance"] = g.ToleranceMS
		}
		if g.Kind == "load-balance" {
			group["strategy"] = g.Strategy
		}
		semantics.group("mihomo", g.ID, g.Kind, resolved, group)
		groups = append(groups, group)
	}
	rules := []string{}
	for _, r := range p.Rules {
		rules = append(rules, mihomoMatch(r.Match)+","+actionName(r.Action, names, "DIRECT", "REJECT"))
	}
	rules = append(rules, "MATCH,"+actionName(p.DefaultAction, names, "DIRECT", "REJECT"))
	providers := map[string]any{}
	for i, r := range p.Resources {
		if r.Behavior != "domain" && r.Behavior != "ipcidr" && r.Behavior != "classical" {
			return ClientResult{}, fmt.Errorf("RULE_BEHAVIOR_UNSUPPORTED: resources[%d]", i)
		}
		format := strings.TrimPrefix(r.Format, "mihomo-")
		if format == "mrs" && r.Behavior == "classical" {
			return ClientResult{}, fmt.Errorf("RULE_FORMAT_UNSUPPORTED: MRS cannot represent classical rules at resources[%d]", i)
		}
		provider := map[string]any{"behavior": r.Behavior, "format": format}
		if r.Location == "local" {
			provider["type"] = "file"
			provider["path"] = r.Path
		} else {
			provider["type"] = "http"
			provider["url"] = r.URL
			provider["interval"] = r.IntervalSeconds
			provider["path"] = "./rules/" + r.ID + "." + format
		}
		providers[r.ID] = provider
	}
	port := p.Runtime.MixedPort
	if port == 0 {
		port = 7890
	}
	config := map[string]any{"mixed-port": port, "bind-address": "127.0.0.1", "allow-lan": false, "mode": "rule", "log-level": "warning", "proxies": proxies, "proxy-groups": groups, "rules": rules}
	if len(providers) > 0 {
		config["rule-providers"] = providers
	}
	if p.Runtime.DNS != nil {
		for _, s := range p.Runtime.DNS.Servers {
			if s.ID != p.Runtime.DNS.Final {
				continue
			}
			port := s.Port
			if port == 0 {
				port = 53
				if s.Type == "tls" {
					port = 853
				}
			}
			scheme := s.Type
			config["dns"] = map[string]any{"enable": true, "enhanced-mode": "redir-host", "nameserver": []string{scheme + "://" + net.JoinHostPort(s.Address, strconv.Itoa(port))}}
		}
	}
	if p.Runtime.Sniff {
		config["sniffer"] = map[string]any{"enable": true, "sniff": map[string]any{"HTTP": map[string]any{"ports": []int{80, 8080}}, "TLS": map[string]any{"ports": []int{443}}, "QUIC": map[string]any{"ports": []int{443}}}}
	}
	result, err := clientResult("mihomo.json", config, p, names)
	result.Semantics = semantics.snapshot()
	return result, err
}
func mihomoMatch(m domain.MatchExpression) string {
	switch m.Op {
	case "domain":
		return "DOMAIN," + m.Value
	case "domain-suffix":
		return "DOMAIN-SUFFIX," + m.Value
	case "ip-cidr":
		if strings.Contains(m.Value, ":") {
			return "IP-CIDR6," + m.Value
		}
		return "IP-CIDR," + m.Value
	case "resource":
		return "RULE-SET," + m.Value
	default:
		children := []string{}
		for _, child := range m.Children {
			children = append(children, "("+mihomoMatch(child)+")")
		}
		return strings.ToUpper(m.Op) + ",(" + strings.Join(children, ",") + ")"
	}
}
