// Package importer extracts connection options from untrusted source material.
// It does not fetch resources, publish subscriptions or mutate accepted snapshots.
package importer

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"routeweaver/internal/domain"
)

type Request struct {
	Previous                                          *domain.SourceSnapshot
	SourceID, SourceName, OwnerID, SnapshotID, Format string
	Data                                              []byte
}
type Diagnostic struct {
	Code    string `json:"code"`
	Index   int    `json:"index,omitempty"`
	Message string `json:"message"`
}
type Result struct {
	Snapshot domain.SourceSnapshot `json:"snapshot"`
	Warnings []Diagnostic          `json:"warnings"`
	Complete bool                  `json:"complete"`
}
type candidate struct {
	Name       string
	Connection domain.Connection
}

var ErrInput = errors.New("subscription input is invalid or contains unsupported connection settings")

func Parse(req Request) (Result, error) {
	result := Result{Snapshot: domain.SourceSnapshot{SourceID: req.SourceID, SourceName: req.SourceName, OwnerID: req.OwnerID, SnapshotID: req.SnapshotID, Endpoints: []domain.ClientEndpoint{}}, Warnings: []Diagnostic{}}
	if !domain.ValidID(req.SourceID) || !domain.ValidID(req.OwnerID) || !domain.ValidID(req.SnapshotID) || len(req.Data) == 0 || len(req.Data) > 16<<20 {
		return result, ErrInput
	}
	if req.Format == "" || req.Format == "auto" {
		text := strings.TrimSpace(string(req.Data))
		switch {
		case strings.HasPrefix(text, "{"):
			var meta map[string]json.RawMessage
			if json.Unmarshal(req.Data, &meta) != nil {
				return result, ErrInput
			}
			_, hasMihomo := meta["proxies"]
			_, hasSingBox := meta["outbounds"]
			if hasMihomo == hasSingBox {
				return result, ErrInput
			}
			if hasMihomo {
				req.Format = "mihomo"
			} else {
				req.Format = "sing-box"
			}
		case firstContentIsURI(text):
			req.Format = "uri-list"
		default:
			if decoded, e := decode64(strings.Join(strings.Fields(text), "")); e == nil && strings.Contains(string(decoded), "://") {
				req.Format = "base64"
			} else {
				req.Format = "mihomo"
			}
		}
	}
	if req.Format == "mihomo-json" {
		req.Format = "mihomo"
	}
	if req.Format == "sing-box-json" {
		req.Format = "sing-box"
	}
	var nodes []candidate
	var warnings []Diagnostic
	var err error
	switch req.Format {
	case "uri-list", "uri", "base64":
		nodes, err = parseURIs(string(req.Data), req.Format == "base64")
	case "mihomo", "sing-box":
		nodes, warnings, err = parseNative(req.Data, req.Format)
	default:
		return result, fmt.Errorf("%w: unsupported import format", ErrInput)
	}
	if err != nil {
		return result, err
	}
	if (len(nodes) == 0 && req.Format != "mihomo" && req.Format != "sing-box") || len(nodes) > 10000 {
		return result, fmt.Errorf("%w: connection count must be at most 10000; empty input requires an explicit native array", ErrInput)
	}
	identities, identityErr := assignIdentities(req, nodes)
	if identityErr != nil {
		return result, identityErr
	}
	endpoints := []domain.ClientEndpoint{}
	for i, node := range nodes {
		if err := domain.ValidateConnection(node.Connection); err != nil {
			return result, fmt.Errorf("%w: connection %d failed validation", ErrInput, i+1)
		}
		if node.Name == "" {
			node.Name = fmt.Sprintf("%s:%d", node.Connection.Host, node.Connection.Port)
		}
		if len(node.Name) > 160 || strings.ContainsAny(node.Name, "\r\n\x00") {
			return result, fmt.Errorf("%w: connection %d has invalid display name", ErrInput, i+1)
		}
		id := identities[i]
		endpoints = append(endpoints, domain.ClientEndpoint{ID: id, Name: node.Name, OwnerID: req.OwnerID, Origin: "imported", Connection: node.Connection, Provenance: []domain.SourceRef{{SourceID: req.SourceID, SourceName: req.SourceName, SnapshotID: req.SnapshotID, EndpointID: id}}})
	}
	result.Snapshot.Endpoints = endpoints
	result.Warnings = append(result.Warnings, warnings...)
	result.Complete = true
	return result, nil
}
func decode64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		b, err := enc.DecodeString(s)
		if err == nil {
			return b, nil
		}
	}
	return nil, ErrInput
}
func parseURIs(text string, encoded bool) ([]candidate, error) {
	text = strings.TrimSpace(text)
	if encoded || !strings.Contains(text, "://") {
		b, err := decode64(strings.Join(strings.Fields(text), ""))
		if err != nil {
			return nil, ErrInput
		}
		text = string(b)
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	nodes := []candidate{}
	if len(lines) > 20000 {
		return nil, ErrInput
	}
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) > 65536 {
			return nil, ErrInput
		}
		node, err := parseURI(line)
		if err != nil {
			return nil, fmt.Errorf("%w: line %d", ErrInput, i+1)
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}
func parseURI(raw string) (candidate, error) {
	if strings.HasPrefix(raw, "vmess://") {
		return parseVMessShare(strings.TrimPrefix(raw, "vmess://"))
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return candidate{}, ErrInput
	}
	portText := u.Port()
	if portText == "" && (u.Scheme == "hy2" || u.Scheme == "hysteria2") && !strings.HasSuffix(u.Host, ":") {
		portText = "443"
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return candidate{}, ErrInput
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return candidate{}, ErrInput
	}
	for _, values := range q {
		if len(values) != 1 {
			return candidate{}, ErrInput
		}
	}
	c := domain.Connection{Host: u.Hostname(), Port: port}
	name := u.Fragment
	switch u.Scheme {
	case "hysteria2", "hy2":
		if u.User == nil || u.Path != "" && u.Path != "/" {
			return candidate{}, ErrInput
		}
		for key := range q {
			if key != "sni" && key != "alpn" {
				return candidate{}, ErrInput
			}
		}
		c.Protocol = "hysteria2"
		c.Password = u.User.Username()
		if password, has := u.User.Password(); has {
			c.Password += ":" + password
		}
		c.TLS = &domain.TLSOptions{Enabled: true, ServerName: q.Get("sni")}
		if value := q.Get("alpn"); value != "" {
			c.TLS.ALPN = strings.Split(value, ",")
		}
	case "socks", "socks5":
		if len(q) != 0 {
			return candidate{}, ErrInput
		}
		c.Protocol = "socks"
		if u.User != nil {
			c.Username = u.User.Username()
			c.Password, _ = u.User.Password()
		}
	case "ss":
		if u.User == nil {
			return candidate{}, ErrInput
		}
		if len(q) != 0 {
			return candidate{}, ErrInput
		}
		c.Protocol = "shadowsocks"
		password, plain := u.User.Password()
		method := u.User.Username()
		if !plain {
			b, err := decode64(method)
			if err != nil {
				return candidate{}, ErrInput
			}
			var ok bool
			method, password, ok = strings.Cut(string(b), ":")
			if !ok {
				return candidate{}, ErrInput
			}
		}
		c.Method = method
		c.Password = password
	case "vless", "trojan":
		if u.User == nil {
			return candidate{}, ErrInput
		}
		if _, ok := u.User.Password(); ok {
			return candidate{}, ErrInput
		}
		c.Protocol = u.Scheme
		if u.Scheme == "trojan" {
			c.Password = u.User.Username()
		} else {
			c.UUID = u.User.Username()
			c.Flow = q.Get("flow")
		}
		allowed := map[string]bool{"type": true, "security": true, "encryption": true, "flow": true, "sni": true, "fp": true, "alpn": true, "pbk": true, "sid": true, "path": true, "host": true, "serviceName": true, "headerType": true}
		if u.Scheme == "trojan" {
			for _, key := range []string{"encryption", "flow", "pbk", "sid"} {
				delete(allowed, key)
			}
		}
		for key := range q {
			if !allowed[key] {
				return candidate{}, ErrInput
			}
		}
		if encryption := q.Get("encryption"); encryption != "" && encryption != "none" {
			return candidate{}, ErrInput
		}
		if header := q.Get("headerType"); header != "" && header != "none" {
			return candidate{}, ErrInput
		}
		transport := q.Get("type")
		if transport == "" || transport == "raw" {
			transport = "tcp"
		}
		c.Transport = &domain.TransportOptions{Type: transport, Path: q.Get("path"), Host: q.Get("host"), ServiceName: q.Get("serviceName")}
		security := q.Get("security")
		if u.Scheme == "trojan" {
			if security == "" {
				security = "tls"
			}
			if security != "tls" {
				return candidate{}, ErrInput
			}
		}
		switch security {
		case "", "none":
			if q.Get("sni") != "" || q.Get("fp") != "" || q.Get("pbk") != "" || q.Get("sid") != "" || q.Get("alpn") != "" {
				return candidate{}, ErrInput
			}
		case "tls", "reality":
			c.TLS = &domain.TLSOptions{Enabled: true, ServerName: q.Get("sni"), Fingerprint: q.Get("fp")}
			if q.Get("alpn") != "" {
				c.TLS.ALPN = strings.Split(q.Get("alpn"), ",")
			}
			if security == "reality" {
				c.TLS.Reality = &domain.RealityOptions{PublicKey: q.Get("pbk"), ShortID: q.Get("sid")}
			} else if q.Get("pbk") != "" || q.Get("sid") != "" {
				return candidate{}, ErrInput
			}
		default:
			return candidate{}, ErrInput
		}
	default:
		return candidate{}, ErrInput
	}
	if u.Path != "" && u.Path != "/" {
		return candidate{}, ErrInput
	}
	if strings.Contains(c.Host, ":") && net.ParseIP(c.Host) == nil {
		return candidate{}, ErrInput
	}
	return candidate{Name: name, Connection: c}, nil
}

func firstContentIsURI(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parsed, err := url.Parse(line)
		return err == nil && parsed.Scheme != "" && strings.HasPrefix(line, parsed.Scheme+"://")
	}
	return false
}

// parseVMessShare accepts the v2rayN version-2 AEAD share-link subset only.
// Unknown fields and legacy alter IDs fail rather than silently downgrade.
func parseVMessShare(encoded string) (candidate, error) {
	body, err := decode64(encoded)
	if err != nil {
		return candidate{}, ErrInput
	}
	var fields map[string]json.RawMessage
	if strictDecode(body, &fields) != nil {
		return candidate{}, ErrInput
	}
	allowed := map[string]bool{}
	for _, key := range []string{"v", "ps", "add", "port", "id", "aid", "scy", "net", "type", "host", "path", "tls", "sni", "alpn", "fp", "insecure"} {
		allowed[key] = true
	}
	values := map[string]string{}
	for key, raw := range fields {
		if !allowed[key] {
			return candidate{}, ErrInput
		}
		var text string
		if json.Unmarshal(raw, &text) != nil {
			if key != "port" && key != "aid" && key != "v" && key != "insecure" {
				return candidate{}, ErrInput
			}
			var number json.Number
			if json.Unmarshal(raw, &number) != nil {
				return candidate{}, ErrInput
			}
			text = number.String()
		}
		values[key] = text
	}
	if values["v"] != "2" || values["aid"] != "" && values["aid"] != "0" || values["insecure"] != "" && values["insecure"] != "0" || values["type"] != "" && values["type"] != "none" {
		return candidate{}, ErrInput
	}
	port, err := strconv.Atoi(values["port"])
	if err != nil {
		return candidate{}, ErrInput
	}
	c := domain.Connection{Protocol: "vmess", Host: values["add"], Port: port, UUID: values["id"], VMessSecurity: values["scy"]}
	transport := values["net"]
	if transport == "" {
		transport = "tcp"
	}
	c.Transport = &domain.TransportOptions{Type: transport, Path: values["path"], Host: values["host"]}
	if transport == "grpc" {
		c.Transport.ServiceName = c.Transport.Path
		c.Transport.Path = ""
	}
	if values["tls"] == "tls" {
		c.TLS = &domain.TLSOptions{Enabled: true, ServerName: values["sni"], Fingerprint: values["fp"]}
		if values["alpn"] != "" {
			c.TLS.ALPN = strings.Split(values["alpn"], ",")
		}
	} else if values["tls"] != "" && values["tls"] != "none" || values["sni"] != "" || values["fp"] != "" || values["alpn"] != "" {
		return candidate{}, ErrInput
	}
	return candidate{Name: values["ps"], Connection: c}, nil
}
