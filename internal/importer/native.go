package importer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
	"routeweaver/internal/domain"
)

type mihomoNode struct {
	AlterID           *int     `json:"alterId"`
	PacketEncoding    string   `json:"packet-encoding"`
	Name              string   `json:"name"`
	Type              string   `json:"type"`
	Server            string   `json:"server"`
	Port              int      `json:"port"`
	Username          string   `json:"username"`
	Password          string   `json:"password"`
	Cipher            string   `json:"cipher"`
	UUID              string   `json:"uuid"`
	Flow              string   `json:"flow"`
	TLS               bool     `json:"tls"`
	ServerName        string   `json:"servername"`
	SNI               string   `json:"sni"`
	ClientFingerprint string   `json:"client-fingerprint"`
	ALPN              []string `json:"alpn"`
	Reality           *struct {
		PublicKey string `json:"public-key"`
		ShortID   string `json:"short-id"`
	} `json:"reality-opts"`
	Network string `json:"network"`
	WS      *struct {
		Path        string            `json:"path"`
		HTTPUpgrade bool              `json:"v2ray-http-upgrade"`
		Headers     map[string]string `json:"headers"`
	} `json:"ws-opts"`
	GRPC *struct {
		ServiceName string `json:"grpc-service-name"`
	} `json:"grpc-opts"`
}

type singboxNode struct {
	AlterID        *int   `json:"alter_id"`
	Security       string `json:"security"`
	PacketEncoding string `json:"packet_encoding"`
	Type           string `json:"type"`
	Tag            string `json:"tag"`
	Server         string `json:"server"`
	Port           int    `json:"server_port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	Method         string `json:"method"`
	Version        string `json:"version"`
	UUID           string `json:"uuid"`
	Flow           string `json:"flow"`
	TLS            *struct {
		Enabled    bool     `json:"enabled"`
		ServerName string   `json:"server_name"`
		ALPN       []string `json:"alpn"`
		UTLS       *struct {
			Enabled     bool   `json:"enabled"`
			Fingerprint string `json:"fingerprint"`
		} `json:"utls"`
		Reality *struct {
			Enabled   bool   `json:"enabled"`
			PublicKey string `json:"public_key"`
			ShortID   string `json:"short_id"`
		} `json:"reality"`
	} `json:"tls"`
	Transport *struct {
		Type        string            `json:"type"`
		Path        string            `json:"path"`
		Host        string            `json:"host"`
		ServiceName string            `json:"service_name"`
		Headers     map[string]string `json:"headers"`
	} `json:"transport"`
}

func strictDecode(data []byte, out any) error {
	if err := validateJSON(data); err != nil {
		return err
	}
	if err := rejectAliasedJSONFields(data, reflect.TypeOf(out)); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return ErrInput
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return ErrInput
	}
	return nil
}
func parseNative(data []byte, format string) ([]candidate, []Diagnostic, error) {
	root := map[string]json.RawMessage{}
	if format == "mihomo" {
		var tree map[string]any
		decoder := yaml.NewDecoder(bytes.NewReader(data))
		if err := decoder.Decode(&tree); err != nil {
			return nil, nil, ErrInput
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return nil, nil, ErrInput
		}
		normalized, err := json.Marshal(tree)
		if err != nil {
			return nil, nil, ErrInput
		}
		if err = json.Unmarshal(normalized, &root); err != nil {
			return nil, nil, ErrInput
		}
	} else {
		if err := validateJSON(data); err != nil {
			return nil, nil, err
		}
		if err := json.Unmarshal(data, &root); err != nil {
			return nil, nil, ErrInput
		}
	}
	key := "outbounds"
	if format == "mihomo" {
		key = "proxies"
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(root[key], &rows); err != nil || rows == nil || len(rows) > 10000 {
		return nil, nil, ErrInput
	}
	warnings := []Diagnostic{}
	keys := []string{}
	for k := range root {
		if k != key {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		warnings = append(warnings, Diagnostic{Code: "connection-extraction", Message: "Only connection options are imported; routing, DNS, groups, providers and other full-configuration settings are not migrated."})
	}
	nodes := []candidate{}
	for i, row := range rows {
		var c candidate
		var err error
		if format == "mihomo" {
			c, err = fromMihomo(row)
		} else {
			var meta struct {
				Type string `json:"type"`
			}
			// Resolve the discriminator only after checking its typed aliases;
			// otherwise a shadowed type can omit a connection as a built-in policy.
			if rejectAliasedJSONFields(row, reflect.TypeOf(meta)) != nil || json.Unmarshal(row, &meta) != nil {
				return nil, nil, ErrInput
			}
			switch meta.Type {
			case "direct", "block", "dns", "selector", "urltest":
				warnings = append(warnings, Diagnostic{Code: "non-connection-outbound", Index: i + 1, Message: "A policy or built-in outbound was not imported as a connection option."})
				continue
			}
			c, err = fromSingBox(row)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("%w: connection %d", ErrInput, i+1)
		}
		nodes = append(nodes, c)
	}
	return nodes, warnings, nil
}
func fromMihomo(raw []byte) (candidate, error) {
	var n mihomoNode
	if strictDecode(raw, &n) != nil {
		return candidate{}, ErrInput
	}
	c := domain.Connection{Host: n.Server, Port: n.Port, Username: n.Username, Password: n.Password, Method: n.Cipher, UUID: n.UUID, Flow: n.Flow, PacketEncoding: n.PacketEncoding}
	switch n.Type {
	case "ss":
		c.Protocol = "shadowsocks"
	case "socks5":
		c.Protocol = "socks"
	case "vless", "trojan", "vmess":
		c.Protocol = n.Type
	default:
		return candidate{}, ErrInput
	}
	if n.AlterID != nil && (*n.AlterID != 0 || n.Type != "vmess") {
		return candidate{}, ErrInput
	}
	if n.Type == "vmess" {
		c.VMessSecurity = n.Cipher
		c.Method = ""
	}
	if n.Type == "trojan" {
		if n.ServerName != "" || n.Reality != nil {
			return candidate{}, ErrInput
		}
		n.ServerName = n.SNI
	} else if n.SNI != "" {
		return candidate{}, ErrInput
	}
	if n.TLS || n.Type == "trojan" {
		c.TLS = &domain.TLSOptions{Enabled: true, ServerName: n.ServerName, Fingerprint: n.ClientFingerprint, ALPN: n.ALPN}
		if n.Reality != nil {
			c.TLS.Reality = &domain.RealityOptions{PublicKey: n.Reality.PublicKey, ShortID: n.Reality.ShortID}
		}
	} else if n.Reality != nil || n.ServerName != "" || n.ClientFingerprint != "" || len(n.ALPN) > 0 {
		return candidate{}, ErrInput
	}
	network := n.Network
	if network == "" {
		network = "tcp"
	}
	if c.Protocol == "vless" || c.Protocol == "trojan" || c.Protocol == "vmess" {
		c.Transport = &domain.TransportOptions{Type: network}
	} else if n.Network != "" || n.WS != nil || n.GRPC != nil {
		return candidate{}, ErrInput
	}
	if n.WS != nil {
		if network != "ws" {
			return candidate{}, ErrInput
		}
		if n.WS.HTTPUpgrade {
			c.Transport.Type = "httpupgrade"
		}
		c.Transport.Path = n.WS.Path
		if err := importTransportHeaders(c.Transport, n.WS.Headers); err != nil {
			return candidate{}, err
		}
	}
	if n.GRPC != nil {
		if network != "grpc" {
			return candidate{}, ErrInput
		}
		c.Transport.ServiceName = n.GRPC.ServiceName
	}
	return candidate{Name: n.Name, Connection: c}, nil
}
func fromSingBox(raw []byte) (candidate, error) {
	var n singboxNode
	if strictDecode(raw, &n) != nil {
		return candidate{}, ErrInput
	}
	c := domain.Connection{Host: n.Server, Port: n.Port, Protocol: n.Type, Username: n.Username, Password: n.Password, Method: n.Method, UUID: n.UUID, Flow: n.Flow, PacketEncoding: n.PacketEncoding}
	if n.Type != "socks" && n.Type != "shadowsocks" && n.Type != "vless" && n.Type != "trojan" && n.Type != "vmess" && n.Type != "hysteria2" {
		return candidate{}, ErrInput
	}
	if n.AlterID != nil && (*n.AlterID != 0 || n.Type != "vmess") || n.Type != "vmess" && n.Security != "" {
		return candidate{}, ErrInput
	}
	c.VMessSecurity = n.Security
	if n.Version != "" && (n.Version != "5" || n.Type != "socks") {
		return candidate{}, ErrInput
	}
	if n.TLS != nil {
		c.TLS = &domain.TLSOptions{Enabled: n.TLS.Enabled, ServerName: n.TLS.ServerName, ALPN: n.TLS.ALPN}
		if n.TLS.UTLS != nil {
			if n.Type == "hysteria2" {
				return candidate{}, ErrInput
			}
			if !n.TLS.UTLS.Enabled {
				return candidate{}, ErrInput
			}
			c.TLS.Fingerprint = n.TLS.UTLS.Fingerprint
		}
		if n.TLS.Reality != nil {
			if !n.TLS.Reality.Enabled {
				return candidate{}, ErrInput
			}
			c.TLS.Reality = &domain.RealityOptions{PublicKey: n.TLS.Reality.PublicKey, ShortID: n.TLS.Reality.ShortID}
		}
	}
	if n.Transport != nil {
		c.Transport = &domain.TransportOptions{Type: n.Transport.Type, Path: n.Transport.Path, Host: n.Transport.Host, ServiceName: n.Transport.ServiceName}
		if err := importTransportHeaders(c.Transport, n.Transport.Headers); err != nil {
			return candidate{}, err
		}
	}
	return candidate{Name: n.Tag, Connection: c}, nil
}

func importTransportHeaders(t *domain.TransportOptions, headers map[string]string) error {
	seen := map[string]bool{}
	for key, value := range headers {
		lower := strings.ToLower(key)
		if seen[lower] {
			return ErrInput
		}
		seen[lower] = true
		if lower == "host" {
			if t.Host != "" {
				return ErrInput
			}
			t.Host = value
			continue
		}
		if t.Headers == nil {
			t.Headers = map[string]string{}
		}
		t.Headers[key] = value
	}
	return nil
}
