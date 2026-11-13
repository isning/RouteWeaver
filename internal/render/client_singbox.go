package render

import (
	"fmt"
	"routeweaver/internal/domain"
	"strings"
)

type SingBoxClient struct{}

func (SingBoxClient) NormalizeName(name string) string { return name }

func (SingBoxClient) ClientCapability() ClientCapability {
	return ClientCapability{NativeOverride: nativeCapability("upstream-json-schema-and-references"), AdapterID: "sing-box", Versions: []string{SingBoxVersion}, Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess", "hysteria2", "anytls"}, Groups: []string{"manual", "url-test"}, MatchOps: []string{"domain", "domain-suffix", "ip-cidr", "resource", "and", "or", "not"}, ResourceFormats: []string{"sing-box-source", "srs"}, Runtime: []string{"dns", "sniff", "tun"}, TLSFingerprints: []string{"chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq", "random", "randomized"}, ReservedNames: []string{"rw-direct"}}
}
func (SingBoxClient) RenderClient(p domain.ClientProfileIR, _ Target, mode OutputMode, names map[string]string) (ClientResult, error) {
	semantics := newSemanticCapture(mode)
	outbounds := []any{}
	for _, e := range p.Endpoints {
		if err := validateClientConnection(e.Connection, (SingBoxClient{}).ClientCapability()); err != nil {
			return ClientResult{}, err
		}
		node := singboxConnection(e.Connection, names[e.ID])
		semantics.node("sing-box", e.ID, node)
		outbounds = append(outbounds, node)
	}
	if mode == NodesOnly {
		return clientResult("sing-box-nodes.json", map[string]any{"outbounds": outbounds}, p, names)
	}
	outbounds = append(outbounds, map[string]any{"type": "direct", "tag": "rw-direct"})
	for _, g := range p.Groups {
		kind := "selector"
		if g.Kind == "url-test" {
			kind = "urltest"
		}
		members := []string{}
		resolved := domain.ResolveGroupMembers(g, p.Endpoints)
		for _, m := range resolved {
			members = append(members, actionName(m, names, "rw-direct", ""))
		}
		group := map[string]any{"type": kind, "tag": names[g.ID], "outbounds": members}
		if g.Kind == "url-test" {
			group["url"] = g.TestURL
			group["interval"] = fmt.Sprintf("%ds", g.IntervalSeconds)
			group["tolerance"] = g.ToleranceMS
		}
		semantics.group("sing-box", g.ID, g.Kind, resolved, group)
		outbounds = append(outbounds, group)
	}
	rules := []any{}
	if p.Runtime.Sniff {
		rules = append(rules, map[string]any{"action": "sniff"})
	}
	for _, r := range p.Rules {
		rule := singboxMatch(r.Match)
		singboxAction(rule, r.Action, names)
		rules = append(rules, rule)
	}
	route := map[string]any{"rules": rules}
	if p.DefaultAction.Kind == "reject" {
		rules = append(rules, map[string]any{"action": "reject"})
		route["rules"] = rules
		route["final"] = "rw-direct"
	} else {
		route["final"] = actionName(p.DefaultAction, names, "rw-direct", "")
	}
	sets, remote, err := singboxRuleSets(p.Resources)
	if err != nil {
		return ClientResult{}, err
	}
	if len(sets) > 0 {
		route["rule_set"] = sets
	}
	port := p.Runtime.MixedPort
	if port == 0 {
		port = 7890
	}
	inbounds := []any{map[string]any{"type": "mixed", "tag": "rw-mixed", "listen": "127.0.0.1", "listen_port": port}}
	if p.Runtime.TUN != nil && p.Runtime.TUN.Enabled {
		inbounds = append(inbounds, map[string]any{"type": "tun", "tag": "rw-tun", "address": p.Runtime.TUN.Addresses, "auto_route": p.Runtime.TUN.AutoRoute, "stack": "system"})
		route["auto_detect_interface"] = true
	}
	config := map[string]any{"log": map[string]any{"level": "warn"}, "inbounds": inbounds, "outbounds": outbounds, "route": route}
	// Explicit resolver prevents native default changes from changing endpoint
	// bootstrap behavior. System DNS is a local resolver, not a hidden public DNS.
	dnsServers := []any{}
	finalDNS := "rw-system-dns"
	if p.Runtime.DNS == nil {
		dnsServers = append(dnsServers, map[string]any{"type": "local", "tag": finalDNS})
	} else {
		finalDNS = p.Runtime.DNS.Final
		for _, s := range p.Runtime.DNS.Servers {
			server := map[string]any{"type": s.Type, "tag": s.ID, "server": s.Address}
			if s.Port != 0 {
				server["server_port"] = s.Port
			}
			dnsServers = append(dnsServers, server)
		}
	}
	config["dns"] = map[string]any{"servers": dnsServers, "final": finalDNS}
	route["default_domain_resolver"] = finalDNS
	if remote {
		config["experimental"] = map[string]any{"cache_file": map[string]any{"enabled": true}}
	}
	result, err := clientResult("sing-box.json", config, p, names)
	result.Semantics = semantics.snapshot()
	return result, err
}
func singboxConnection(c domain.Connection, tag string) map[string]any {
	o := map[string]any{"type": c.Protocol, "tag": tag, "server": c.Host, "server_port": c.Port}
	if c.Protocol == "socks" {
		o["version"] = "5"
		if c.Username != "" {
			o["username"] = c.Username
			o["password"] = c.Password
		}
	} else if c.Protocol == "vless" || c.Protocol == "trojan" || c.Protocol == "vmess" || (c.Protocol == "hysteria2" || c.Protocol == "anytls") {
		if c.Protocol == "trojan" || (c.Protocol == "hysteria2" || c.Protocol == "anytls") {
			o["password"] = c.Password
		} else {
			o["uuid"] = c.UUID
		}
		if c.Protocol == "vmess" {
			o["security"] = vmessSecurity(c)
			o["alter_id"] = 0
		}
		if c.PacketEncoding != "" {
			o["packet_encoding"] = c.PacketEncoding
		}
		if c.Flow != "" {
			o["flow"] = c.Flow
		}
		if c.TLS != nil && c.TLS.Enabled {
			tls := map[string]any{"enabled": true}
			if c.TLS.ServerName != "" {
				tls["server_name"] = c.TLS.ServerName
			}
			if len(c.TLS.ALPN) > 0 {
				tls["alpn"] = c.TLS.ALPN
			}
			if c.TLS.Fingerprint != "" {
				tls["utls"] = map[string]any{"enabled": true, "fingerprint": strings.ToLower(c.TLS.Fingerprint)}
			}
			if c.TLS.Reality != nil {
				tls["reality"] = map[string]any{"enabled": true, "public_key": c.TLS.Reality.PublicKey, "short_id": c.TLS.Reality.ShortID}
			}
			o["tls"] = tls
		}
		if c.Transport != nil && c.Transport.Type != "tcp" {
			tr := c.Transport
			transport := map[string]any{"type": tr.Type}
			switch tr.Type {
			case "ws":
				transport["path"] = tr.Path
				if headers := transportHeaders(tr, true); len(headers) > 0 {
					transport["headers"] = headers
				}
			case "httpupgrade":
				transport["path"] = tr.Path
				transport["host"] = tr.Host
				if headers := transportHeaders(tr, false); len(headers) > 0 {
					transport["headers"] = headers
				}
			case "grpc":
				transport["service_name"] = tr.ServiceName
			}
			o["transport"] = transport
		}
	} else {
		o["method"] = c.Method
		o["password"] = c.Password
	}
	return o
}
func singboxMatch(m domain.MatchExpression) map[string]any {
	switch m.Op {
	case "and", "or":
		children := []any{}
		for _, c := range m.Children {
			children = append(children, singboxMatch(c))
		}
		return map[string]any{"type": "logical", "mode": m.Op, "rules": children}
	case "not":
		r := singboxMatch(m.Children[0])
		r["invert"] = r["invert"] != true
		return r
	case "resource":
		return map[string]any{"rule_set": []string{m.Value}}
	case "domain":
		return map[string]any{"domain": []string{m.Value}}
	case "domain-suffix":
		return map[string]any{"domain_suffix": []string{m.Value}}
	default:
		return map[string]any{"ip_cidr": []string{m.Value}}
	}
}
func singboxAction(rule map[string]any, a domain.ActionRef, names map[string]string) {
	if a.Kind == "reject" {
		rule["action"] = "reject"
	} else {
		rule["action"] = "route"
		rule["outbound"] = actionName(a, names, "rw-direct", "")
	}
}

func transportHeaders(t *domain.TransportOptions, includeHost bool) map[string]string {
	headers := make(map[string]string, len(t.Headers)+1)
	for key, value := range t.Headers {
		headers[key] = value
	}
	if includeHost && t.Host != "" {
		headers["Host"] = t.Host
	}
	return headers
}

func vmessSecurity(c domain.Connection) string {
	if c.VMessSecurity == "" {
		return "auto"
	}
	return c.VMessSecurity
}
