// Package domain contains core-neutral configuration contracts. No core SDK or persistence imports belong here.
package domain

import (
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
)

type Node struct {
	CoreID         string            `json:"coreId,omitempty"`
	CoreVersion    string            `json:"coreVersion,omitempty"`
	Status         string            `json:"status"`
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Host           string            `json:"host"`
	Port           int               `json:"port"`
	Protocol       string            `json:"protocol"`
	Username       string            `json:"username,omitempty"`
	Password       string            `json:"password,omitempty"`
	Method         string            `json:"method,omitempty"`
	Region         string            `json:"region,omitempty"`
	Tags           []string          `json:"tags,omitempty"`
	UUID           string            `json:"uuid,omitempty"`
	Flow           string            `json:"flow,omitempty"`
	VMessSecurity  string            `json:"vmessSecurity,omitempty"`
	PacketEncoding string            `json:"packetEncoding,omitempty"`
	TLS            *TLSOptions       `json:"tls,omitempty"`
	Transport      *TransportOptions `json:"transport,omitempty"`
}
type User struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Enabled    bool   `json:"enabled"`
	QuotaBytes int64  `json:"quotaBytes"`
	UsedBytes  int64  `json:"usedBytes"`
}
type Route struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Hops         []string `json:"hops"`
	Engine       string   `json:"engine"`
	UserIDs      []string `json:"userIds"`
	NameTemplate string   `json:"nameTemplate,omitempty"`
}
type Artifact struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type Revision struct {
	NativeChecked bool       `json:"nativeChecked"`
	ID            string     `json:"id"`
	RouteID       string     `json:"routeId"`
	Engine        string     `json:"engine"`
	Status        string     `json:"status"`
	CreatedAt     time.Time  `json:"createdAt"`
	Artifacts     []Artifact `json:"artifacts"`
	Digest        string     `json:"digest"`
}
type Capability struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Protocols []string `json:"protocols"`
	MaxHops   int      `json:"maxHops"` // zero means no adapter-imposed structural limit
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func ValidID(s string) bool { return idPattern.MatchString(s) }
func ValidateNode(n Node) error {
	if !ValidID(n.ID) || strings.TrimSpace(n.Name) == "" {
		return fmt.Errorf("node id and name required")
	}
	if n.Port < 1 || n.Port > 65535 {
		return fmt.Errorf("port must be 1–65535")
	}
	if n.Host == "" || strings.ContainsAny(n.Host, " /\\\t\n\r") || strings.Contains(n.Host, ":") && net.ParseIP(n.Host) == nil {
		return fmt.Errorf("host must be a hostname or IP, not a URL")
	}
	if n.Protocol != "vless" && n.Protocol != "trojan" && n.Protocol != "vmess" && n.Protocol != "hysteria2" && n.Protocol != "anytls" && (n.VMessSecurity != "" || n.UUID != "" || n.Flow != "" || n.PacketEncoding != "" || n.TLS != nil || n.Transport != nil) {
		return fmt.Errorf("protocol does not accept VLESS security or transport fields")
	}
	switch n.Protocol {
	case "vless", "trojan", "vmess", "hysteria2", "anytls":
		return ValidateConnection(n.ConnectionValue())
	case "socks":
		if n.Method != "" {
			return fmt.Errorf("SOCKS does not accept a cipher method")
		}
		if (n.Username == "") != (n.Password == "") {
			return fmt.Errorf("SOCKS username and password must be supplied together")
		}
	case "shadowsocks":
		if n.Username != "" {
			return fmt.Errorf("Shadowsocks does not accept a username")
		}
		if n.Password == "" {
			return fmt.Errorf("Shadowsocks password required")
		}
		switch n.Method {
		case "aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305":
		default:
			return fmt.Errorf("unsupported Shadowsocks cipher")
		}
	default:
		return fmt.Errorf("unsupported protocol %q", n.Protocol)
	}
	return nil
}
func ValidateRoute(r Route, nodes []Node) error {
	if !ValidID(r.ID) || strings.TrimSpace(r.Name) == "" {
		return fmt.Errorf("route id and name required")
	}
	if len(r.Hops) < 1 {
		return fmt.Errorf("routes require at least one endpoint")
	}
	seen := map[string]bool{}
	index := map[string]Node{}
	for _, n := range nodes {
		if _, ok := index[n.ID]; ok {
			return fmt.Errorf("duplicate endpoint identity %s", n.ID)
		}
		index[n.ID] = n
	}
	for _, id := range r.Hops {
		if seen[id] {
			return fmt.Errorf("route contains cycle at %s", id)
		}
		seen[id] = true
		n, ok := index[id]
		if !ok {
			return fmt.Errorf("node %s does not exist", id)
		}
		if err := ValidateNode(n); err != nil {
			return fmt.Errorf("node %s: %w", id, err)
		}
	}
	return nil
}
func SubscriptionName(r Route, nodes []Node) (string, error) {
	name := r.NameTemplate
	if name == "" {
		name = "{route} · {region}"
	}
	region := "unknown"
	for _, n := range nodes {
		if len(r.Hops) > 0 && n.ID == r.Hops[len(r.Hops)-1] && n.Region != "" {
			region = n.Region
		}
	}
	name = strings.NewReplacer("{route}", r.Name, "{region}", region, "{engine}", r.Engine, "{id}", r.ID).Replace(name)
	if strings.ContainsAny(name, "{}\n\r") {
		return "", fmt.Errorf("name template has unknown placeholders or newlines")
	}
	if len(name) > 200 {
		return "", fmt.Errorf("subscription name too long")
	}
	return name, nil
}

// ConnectionValue adapts the legacy conflated Node DTO without promoting it to
// a host/core-instance identity in the new domain model.
func (n Node) ConnectionValue() Connection {
	return Connection{Host: n.Host, Port: n.Port, Protocol: n.Protocol, Username: n.Username, Password: n.Password, Method: n.Method, UUID: n.UUID, Flow: n.Flow, PacketEncoding: n.PacketEncoding, VMessSecurity: n.VMessSecurity, TLS: n.TLS, Transport: n.Transport}
}
