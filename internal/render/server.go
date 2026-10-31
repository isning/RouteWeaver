package render

import (
	"bytes"
	"crypto/ecdh"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"path"
	"routeweaver/internal/domain"
	"slices"
	"strings"
)

const (
	ServerAdapterXray    = "routeweaver/xray"
	ServerAdapterSingBox = "routeweaver/sing-box"
	// Current stock release defaults do not change client or managed identities.
	StockXrayVersion    = "26.10.31"
	StockSingBoxVersion = "1.14.4"
	// Historical identities remain supported for saved configurations and recovery.
	HistoricalStockXrayVersion    = "26.3.27"
	HistoricalStockSingBoxVersion = "1.14.3"
	// XrayVersion retains the historical configuration/test contract.
	XrayVersion = HistoricalStockXrayVersion
)

type ServerCapability struct {
	AdapterID               string   `json:"adapterId"`
	Versions                []string `json:"versions"`
	Protocols               []string `json:"protocols"`
	EgressProtocols         []string `json:"egressProtocols,omitempty"`
	MultiPrincipalProtocols []string `json:"multiPrincipalProtocols,omitempty"`
	ManagedAccess           bool     `json:"managedAccess"`
}
type ServerRenderer interface {
	ServerCapability() ServerCapability
	RenderServer(domain.ServerProgram) (any, error)
}
type ServerRegistry struct{ adapters map[string]ServerRenderer }

func NewServers(adapters ...ServerRenderer) *ServerRegistry {
	r := &ServerRegistry{adapters: map[string]ServerRenderer{}}
	for _, a := range adapters {
		if err := r.Register(a); err != nil {
			panic(err)
		}
	}
	return r
}
func (r *ServerRegistry) Register(a ServerRenderer) error {
	c := a.ServerCapability()
	if !validAdapterID(c.AdapterID) || len(c.Versions) == 0 {
		return fmt.Errorf("invalid server adapter descriptor")
	}
	if _, ok := r.adapters[c.AdapterID]; ok {
		return fmt.Errorf("server adapter already registered")
	}
	r.adapters[c.AdapterID] = a
	return nil
}
func DefaultServers() *ServerRegistry {
	return NewServers(XrayServer{}, SingBoxServer{}, ManagedXrayServer{})
}
func (r *ServerRegistry) Render(ir domain.ServerDeploymentIR) ([]domain.Artifact, error) {
	if ir.SchemaVersion != "1.0" || !domain.ValidID(ir.ID) || ir.TopologyRevision == "" || len(ir.Programs) == 0 {
		return nil, fmt.Errorf("invalid server deployment envelope")
	}
	artifacts := []domain.Artifact{}
	seen := map[string]bool{}
	for i, p := range ir.Programs {
		if !domain.ValidID(p.Instance.ID) || !domain.ValidID(p.Instance.HostID) || seen[p.Instance.ID] || p.Listener.InstanceID != p.Instance.ID || !domain.ValidID(p.Listener.ID) {
			return nil, fmt.Errorf("programs[%d]: invalid instance or listener identity", i)
		}
		seen[p.Instance.ID] = true
		a, ok := r.adapters[p.Instance.AdapterID]
		if !ok {
			return nil, fmt.Errorf("SERVER_TARGET_UNSUPPORTED: programs[%d]", i)
		}
		c := a.ServerCapability()
		if !has(c.Versions, p.Instance.Version) {
			return nil, fmt.Errorf("SERVER_VERSION_UNVERIFIED: programs[%d]", i)
		}
		if err := domain.ValidateDestinationPolicy(p.DestinationPolicy); err != nil {
			return nil, err
		}
		if p.DestinationPolicy != nil && !c.ManagedAccess && !supportsStockXrayDestinationPolicy(p) {
			return nil, fmt.Errorf("SERVER_DESTINATION_POLICY_UNVERIFIED: selected adapter does not enforce resolved target policy")
		}
		if err := domain.ValidateServerListener(p); err != nil {
			return nil, fmt.Errorf("programs[%d].listener: %w", i, err)
		}
		if net.ParseIP(p.Listener.Connection.Host) == nil {
			return nil, fmt.Errorf("programs[%d]: listener must bind an explicit IP address", i)
		}
		if p.Listener.Connection.Protocol == "socks" && p.Listener.Connection.Username == "" {
			return nil, fmt.Errorf("programs[%d]: managed SOCKS listener requires authentication", i)
		}
		if p.Listener.Connection.Transport != nil && p.Listener.Connection.Transport.Authority != "" {
			return nil, fmt.Errorf("GRPC_AUTHORITY_OUTBOUND_ONLY: listener authority is not enforced")
		}
		if !has(c.Protocols, p.Listener.Connection.Protocol) {
			return nil, fmt.Errorf("SERVER_PROTOCOL_UNSUPPORTED: programs[%d].listener", i)
		}
		if len(p.Principals) > 0 && !has(c.MultiPrincipalProtocols, p.Listener.Connection.Protocol) {
			return nil, fmt.Errorf("SERVER_PRINCIPALS_UNVERIFIED: programs[%d].listener", i)
		}
		var err error
		p, err = normalizeServerProgram(p)
		if err != nil {
			return nil, fmt.Errorf("programs[%d]: %w", i, err)
		}
		if err := validateServerTLS(p); err != nil {
			return nil, fmt.Errorf("programs[%d].tls: %w", i, err)
		}
		for j, connector := range p.Connectors {
			e := connector.Connection
			if err := domain.ValidateConnection(e); err != nil {
				return nil, fmt.Errorf("programs[%d].egress[%d]: %w", i, j, err)
			}
			egressProtocols := c.EgressProtocols
			if len(egressProtocols) == 0 {
				egressProtocols = c.Protocols
			}
			if !has(egressProtocols, e.Protocol) {
				return nil, fmt.Errorf("SERVER_PROTOCOL_UNSUPPORTED: programs[%d].egress[%d]", i, j)
			}
		}
		config, err := a.RenderServer(p)
		if err != nil {
			return nil, err
		}
		b, err := json.MarshalIndent(config, "", "  ")
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, domain.Artifact{Path: p.Instance.ID + "/config.json", Content: string(b) + "\n"})
		if p.TLS != nil && p.TLS.CertificatePEM != "" {
			artifacts = append(artifacts, domain.Artifact{Path: p.Instance.ID + "/" + p.TLS.CertificatePath, Content: p.TLS.CertificatePEM}, domain.Artifact{Path: p.Instance.ID + "/" + p.TLS.KeyPath, Content: p.TLS.PrivateKeyPEM})
		}
		if extra, ok := a.(ServerArtifactRenderer); ok {
			parts, err := extra.ServerArtifacts(p)
			if err != nil {
				return nil, err
			}
			for _, part := range parts {
				part.Path = p.Instance.ID + "/" + part.Path
				artifacts = append(artifacts, part)
			}
		}
	}
	return artifacts, nil
}
func validateServerTLS(p domain.ServerProgram) error {
	c := p.Listener.Connection
	if c.TLS == nil || !c.TLS.Enabled {
		if p.TLS != nil {
			return fmt.Errorf("server key material supplied without TLS listener")
		}
		return nil
	}
	if p.TLS == nil {
		return fmt.Errorf("TLS listener needs server certificate or REALITY material")
	}
	if p.TLS.Reality == nil {
		if (p.TLS.CertificatePEM == "") != (p.TLS.PrivateKeyPEM == "") {
			return fmt.Errorf("certificate and private key PEM must be supplied together")
		}
		if p.TLS.CertificatePath == p.TLS.KeyPath || p.TLS.CertificatePath == "config.json" || p.TLS.KeyPath == "config.json" || p.TLS.CertificatePath == "entry-policy.json" || p.TLS.KeyPath == "entry-policy.json" {
			return fmt.Errorf("TLS material paths collide with each other or reserved runtime files")
		}
		if p.TLS.CertificatePEM != "" {
			if len(p.TLS.CertificatePEM) > 1<<20 || len(p.TLS.PrivateKeyPEM) > 1<<20 {
				return fmt.Errorf("TLS material too large")
			}
			if _, err := tls.X509KeyPair([]byte(p.TLS.CertificatePEM), []byte(p.TLS.PrivateKeyPEM)); err != nil {
				return fmt.Errorf("TLS certificate and private key do not form a valid matching pair")
			}
		}

		if c.TLS.Reality != nil {
			return fmt.Errorf("REALITY client parameters need REALITY server material")
		}
		for _, s := range []string{p.TLS.CertificatePath, p.TLS.KeyPath} {
			if s == "" || path.IsAbs(s) || strings.Contains(s, "\\") || path.Clean(s) != s || strings.HasPrefix(s, "../") {
				return fmt.Errorf("TLS certificate/key paths must be safe relative paths")
			}
		}
		return nil
	}
	r := p.TLS.Reality
	key, err := base64.RawURLEncoding.DecodeString(r.PrivateKey)
	if err != nil || len(key) != 32 {
		return fmt.Errorf("invalid REALITY server key")
	}
	if r.HandshakeServer == "" || r.HandshakePort < 1 || r.HandshakePort > 65535 || len(r.ShortIDs) == 0 || len(r.ServerNames) == 0 {
		return fmt.Errorf("explicit REALITY handshake, short IDs and names required")
	}
	for _, id := range r.ShortIDs {
		b, err := hex.DecodeString(id)
		if err != nil || len(b) > 8 {
			return fmt.Errorf("invalid REALITY short ID")
		}
	}
	if p.TLS.CertificatePath != "" || p.TLS.KeyPath != "" || p.TLS.CertificatePEM != "" || p.TLS.PrivateKeyPEM != "" {
		return fmt.Errorf("certificate and REALITY modes are mutually exclusive")
	}
	return validateRealityPair(c.TLS, r, key)
}

// The same listener also supplies client/subscription and transit parameters.
// Accept only parameters that authenticate against the declared server material.
func validateRealityPair(client *domain.TLSOptions, server *domain.ServerRealityOptions, privateKey []byte) error {
	if client.Reality == nil {
		return fmt.Errorf("REALITY server material needs matching client parameters")
	}
	key, err := ecdh.X25519().NewPrivateKey(privateKey)
	if err != nil {
		return fmt.Errorf("invalid REALITY server key")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(client.Reality.PublicKey)
	if err != nil || !bytes.Equal(publicKey, key.PublicKey().Bytes()) {
		return fmt.Errorf("REALITY client public key does not match server private key")
	}
	if !slices.Contains(server.ServerNames, client.ServerName) {
		return fmt.Errorf("REALITY client server name is not accepted by server")
	}
	// Both pinned cores decode short IDs into zero-padded eight-byte values.
	short, err := hex.DecodeString(client.Reality.ShortID)
	if err != nil || len(short) > 8 {
		return fmt.Errorf("invalid REALITY client short ID")
	}
	var advertised [8]byte
	copy(advertised[:], short)
	for _, value := range server.ShortIDs {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) > 8 {
			continue
		}
		var accepted [8]byte
		copy(accepted[:], decoded)
		if advertised == accepted {
			return nil
		}
	}
	return fmt.Errorf("REALITY client short ID is not accepted by server")
}

// The reviewed stock runtime applies its default resolved-IP guard only to these
// inbound protocols. Do not advertise exceptions for SOCKS or historical cores.
// https://github.com/XTLS/Xray-core/blob/v26.10.31/proxy/freedom/freedom.go
func supportsStockXrayDestinationPolicy(p domain.ServerProgram) bool {
	return p.Instance.AdapterID == ServerAdapterXray && (p.Instance.Version == StockXrayVersion || p.Instance.Version == "26.10.29") &&
		has([]string{"vless", "vmess", "trojan", "shadowsocks"}, p.Listener.Connection.Protocol)
}

type XrayServer struct{}

func (XrayServer) ServerCapability() ServerCapability {
	return ServerCapability{AdapterID: ServerAdapterXray, Versions: []string{StockXrayVersion, "26.10.29", HistoricalStockXrayVersion}, Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}, MultiPrincipalProtocols: []string{"vless"}}
}
func (XrayServer) RenderServer(p domain.ServerProgram) (any, error) {
	if err := validateXraySecurity(p.Listener.Connection); err != nil {
		return nil, err
	}
	if err := domain.ValidateListenerTransport(p.Listener.Connection); err != nil {
		return nil, err
	}
	c := p.Listener.Connection
	inbound := map[string]any{"tag": p.Listener.ID, "listen": c.Host, "port": c.Port, "protocol": c.Protocol}
	switch c.Protocol {
	case "socks":
		inbound["settings"] = map[string]any{"auth": "password", "accounts": []any{map[string]any{"user": c.Username, "pass": c.Password}}, "udp": false}
	case "shadowsocks":
		inbound["settings"] = map[string]any{"method": c.Method, "password": c.Password, "network": "tcp,udp"}
	case "vless", "trojan", "vmess":
		user := map[string]any{"id": c.UUID}
		if c.Protocol == "trojan" {
			user = map[string]any{"password": c.Password}
		}
		if c.Flow != "" {
			user["flow"] = c.Flow
		}
		users := []any{user}
		if len(p.Principals) > 0 || p.Listener.Authentication == "principals" {
			users = nativePrincipalUsers(p, true)
		}
		inbound["settings"] = map[string]any{"clients": users}
		if c.Protocol == "vless" {
			inbound["settings"].(map[string]any)["decryption"] = "none"
		}
		stream := xrayStream(c)
		if c.TLS != nil && c.TLS.Enabled {
			if p.TLS.Reality != nil {
				r := p.TLS.Reality
				stream["security"] = "reality"
				stream["realitySettings"] = map[string]any{"target": net.JoinHostPort(r.HandshakeServer, fmt.Sprint(r.HandshakePort)), "serverNames": r.ServerNames, "privateKey": r.PrivateKey, "shortIds": r.ShortIDs}
				delete(stream, "tlsSettings")
			} else {
				stream["security"] = "tls"
				stream["tlsSettings"] = map[string]any{"certificates": []any{map[string]any{"certificateFile": p.TLS.CertificatePath, "keyFile": p.TLS.KeyPath}}}
				if len(c.TLS.ALPN) > 0 {
					stream["tlsSettings"].(map[string]any)["alpn"] = c.TLS.ALPN
				}
				delete(stream, "realitySettings")
			}
		}
		inbound["streamSettings"] = stream
	}
	outs := []any{}
	names := connectorNames(p)
	for _, connector := range p.Connectors {
		e := connector.Connection
		if err := validateOutboundTarget(e, "xray"); err != nil {
			return nil, err
		}
		out := xrayConnection(e, connector.ID)
		if connector.Via != "" {
			stream, ok := out["streamSettings"].(map[string]any)
			if !ok {
				stream = map[string]any{}
				out["streamSettings"] = stream
			}
			stream["sockopt"] = map[string]any{"dialerProxy": connector.Via}
		}
		outs = append(outs, out)
	}
	directSettings := map[string]any{}
	if supportsStockXrayDestinationPolicy(p) && p.DestinationPolicy != nil && len(p.DestinationPolicy.AllowCIDRs) > 0 {
		// Matching bounded exceptions precede the upstream default guard; no
		// catch-all allow rule or connector policy is synthesized.
		finalRules := []any{}
		for _, cidr := range p.DestinationPolicy.AllowCIDRs {
			finalRules = append(finalRules, map[string]any{"action": "allow", "ip": []string{cidr}})
		}
		directSettings["finalRules"] = finalRules
	}
	outs = append(outs, map[string]any{"tag": "rw-direct", "protocol": "freedom", "settings": directSettings}, map[string]any{"tag": "rw-reject", "protocol": "blackhole", "settings": map[string]any{}})
	if len(p.Resources) > 0 {
		return nil, fmt.Errorf("XRAY_RULE_RESOURCE_UNSUPPORTED: DAT resources need a separate proven adapter; no file is flattened")
	}
	rules := principalRules(p, true)
	for _, r := range p.Rules {
		rule, err := xrayPolicyMatch(r.Match)
		if err != nil {
			return nil, err
		}
		rule["type"] = "field"
		rule["inboundTag"] = []string{p.Listener.ID}
		rule["outboundTag"] = actionName(r.Action, names, "rw-direct", "rw-reject")
		rules = append(rules, rule)
	}
	rules = append(rules, map[string]any{"type": "field", "inboundTag": []string{p.Listener.ID}, "outboundTag": actionName(p.DefaultAction, names, "rw-direct", "rw-reject")})
	return map[string]any{"log": map[string]any{"loglevel": "warning"}, "inbounds": []any{inbound}, "outbounds": outs, "routing": map[string]any{"rules": rules}}, nil
}

func xrayConnection(c domain.Connection, tag string) map[string]any {
	o := map[string]any{"tag": tag, "protocol": c.Protocol}
	if c.Protocol == "trojan" {
		o["settings"] = map[string]any{"address": c.Host, "port": c.Port, "password": c.Password}
		o["streamSettings"] = xrayStream(c)
	} else if c.Protocol == "vmess" {
		o["settings"] = map[string]any{"vnext": []any{map[string]any{"address": c.Host, "port": c.Port, "users": []any{map[string]any{"id": c.UUID, "security": vmessSecurity(c)}}}}}
		o["streamSettings"] = xrayStream(c)
	} else if c.Protocol == "vless" {
		settings := map[string]any{"address": c.Host, "port": c.Port, "id": c.UUID, "encryption": "none"}
		if c.Flow != "" {
			settings["flow"] = c.Flow
		}
		o["settings"] = settings
		o["streamSettings"] = xrayStream(c)
	} else {
		server := map[string]any{"address": c.Host, "port": c.Port}
		if c.Protocol == "socks" && c.Username != "" {
			server["users"] = []any{map[string]any{"user": c.Username, "pass": c.Password}}
		}
		if c.Protocol == "shadowsocks" {
			server["method"] = c.Method
			server["password"] = c.Password
		}
		o["settings"] = map[string]any{"servers": []any{server}}
	}
	return o
}
func xrayStream(c domain.Connection) map[string]any {
	s := map[string]any{"network": "raw", "security": "none"}
	if c.Transport != nil {
		t := c.Transport
		switch t.Type {
		case "ws":
			s["network"] = "ws"
			s["wsSettings"] = map[string]any{"path": t.Path, "host": t.Host}
			if len(t.Headers) > 0 {
				s["wsSettings"].(map[string]any)["headers"] = transportHeaders(t, false)
			}
		case "grpc":
			s["network"] = "grpc"
			s["grpcSettings"] = map[string]any{"serviceName": t.ServiceName}
			if t.Authority != "" {
				s["grpcSettings"].(map[string]any)["authority"] = t.Authority
			}
		case "httpupgrade":
			s["network"] = "httpupgrade"
			s["httpupgradeSettings"] = map[string]any{"path": t.Path, "host": t.Host}
			if len(t.Headers) > 0 {
				s["httpupgradeSettings"].(map[string]any)["headers"] = transportHeaders(t, false)
			}
		}
	}
	if c.TLS != nil && c.TLS.Enabled {
		t := c.TLS
		settings := map[string]any{}
		if t.ServerName != "" {
			settings["serverName"] = t.ServerName
		}
		if t.Fingerprint != "" {
			settings["fingerprint"] = t.Fingerprint
		}
		if len(t.ALPN) > 0 {
			settings["alpn"] = t.ALPN
		}
		s["security"] = "tls"
		if t.Reality != nil {
			s["security"] = "reality"
			settings["password"] = t.Reality.PublicKey
			settings["shortId"] = t.Reality.ShortID
			s["realitySettings"] = settings
		} else {
			s["tlsSettings"] = settings
		}
	}
	return s
}

type SingBoxServer struct{}

func (SingBoxServer) ServerCapability() ServerCapability {
	return ServerCapability{AdapterID: ServerAdapterSingBox, Versions: []string{StockSingBoxVersion, HistoricalStockSingBoxVersion}, Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}, MultiPrincipalProtocols: []string{"vless"}}
}
func (SingBoxServer) RenderServer(p domain.ServerProgram) (any, error) {
	if err := domain.ValidateListenerTransport(p.Listener.Connection); err != nil {
		return nil, err
	}
	if p.Listener.Connection.Transport != nil && p.Listener.Connection.Transport.Authority != "" {
		return nil, fmt.Errorf("GRPC_AUTHORITY_UNSUPPORTED: listener")
	}
	for _, c := range p.Connectors {
		if err := validateOutboundTarget(c.Connection, "sing-box"); err != nil {
			return nil, err
		}
	}
	for _, c := range p.Egress {
		if c.Transport != nil && c.Transport.Authority != "" {
			return nil, fmt.Errorf("GRPC_AUTHORITY_UNSUPPORTED: egress")
		}
	}

	c := p.Listener.Connection
	inbound := map[string]any{"type": c.Protocol, "tag": p.Listener.ID, "listen": c.Host, "listen_port": c.Port}
	switch c.Protocol {
	case "socks":
		inbound["users"] = []any{map[string]any{"username": c.Username, "password": c.Password}}
	case "shadowsocks":
		inbound["method"] = c.Method
		inbound["password"] = c.Password
	case "vless", "trojan", "vmess":
		user := map[string]any{"name": p.Listener.ID, "uuid": c.UUID}
		if c.Protocol == "trojan" {
			user = map[string]any{"name": p.Listener.ID, "password": c.Password}
		}
		if c.Flow != "" {
			user["flow"] = c.Flow
		}
		users := []any{user}
		if len(p.Principals) > 0 || p.Listener.Authentication == "principals" {
			users = nativePrincipalUsers(p, false)
		}
		inbound["users"] = users
		out := singboxConnection(c, "unused")
		if tr, ok := out["transport"]; ok {
			if c.Transport != nil && c.Transport.Type == "ws" {
				delete(tr.(map[string]any), "headers")
			}
			inbound["transport"] = tr
		}
		if c.TLS != nil && c.TLS.Enabled {
			tls := map[string]any{"enabled": true}
			if len(c.TLS.ALPN) > 0 {
				tls["alpn"] = c.TLS.ALPN
			}
			if p.TLS.Reality != nil {
				r := p.TLS.Reality
				if len(r.ServerNames) != 1 {
					return nil, fmt.Errorf("SINGBOX_REALITY_NAMES_UNSUPPORTED: exactly one handshake server name required")
				}
				tls["server_name"] = r.ServerNames[0]
				tls["reality"] = map[string]any{"enabled": true, "handshake": map[string]any{"server": r.HandshakeServer, "server_port": r.HandshakePort}, "private_key": r.PrivateKey, "short_id": r.ShortIDs}
			} else {
				tls["certificate_path"] = p.TLS.CertificatePath
				tls["key_path"] = p.TLS.KeyPath
			}
			inbound["tls"] = tls
		}
	}
	outs := []any{}
	names := connectorNames(p)
	for _, connector := range p.Connectors {
		out := singboxConnection(connector.Connection, connector.ID)
		if connector.Via != "" {
			out["detour"] = connector.Via
		}
		outs = append(outs, out)
	}
	outs = append(outs, map[string]any{"type": "direct", "tag": "rw-direct"})
	rules := principalRules(p, false)
	for _, r := range p.Rules {
		rule := singboxMatch(r.Match)
		singboxAction(rule, r.Action, names)
		rules = append(rules, rule)
	}
	final := actionName(p.DefaultAction, names, "rw-direct", "")
	if p.DefaultAction.Kind == "reject" {
		rules = append(rules, map[string]any{"action": "reject"})
		final = "rw-direct"
	}
	sets, remote, err := singboxRuleSets(p.Resources)
	if err != nil {
		return nil, err
	}
	route := map[string]any{"final": final, "rules": rules, "default_domain_resolver": "rw-system-dns"}
	if len(sets) > 0 {
		route["rule_set"] = sets
	}
	config := map[string]any{"log": map[string]any{"level": "warn"}, "inbounds": []any{inbound}, "outbounds": outs, "dns": map[string]any{"servers": []any{map[string]any{"type": "local", "tag": "rw-system-dns"}}, "final": "rw-system-dns"}, "route": route}
	if remote {
		config["experimental"] = map[string]any{"cache_file": map[string]any{"enabled": true}}
	}
	return config, nil
}
