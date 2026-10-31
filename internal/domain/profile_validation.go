package domain

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path"
	"regexp"
	"strings"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func ValidateConnection(c Connection) error {
	if c.Protocol != "vmess" && c.VMessSecurity != "" {
		return fmt.Errorf("VMess security requires VMess protocol")
	}
	if c.Protocol != "vless" && c.Protocol != "trojan" && c.Protocol != "vmess" {
		if c.PacketEncoding != "" || c.UUID != "" || c.Flow != "" || c.TLS != nil || c.Transport != nil {
			return fmt.Errorf("protocol does not accept VLESS security or transport fields")
		}
		return ValidateNode(Node{ID: "connection", Name: "connection", Host: c.Host, Port: c.Port, Protocol: c.Protocol, Username: c.Username, Password: c.Password, Method: c.Method})
	}
	if err := ValidateNode(Node{ID: "connection", Name: "connection", Host: c.Host, Port: c.Port, Protocol: "socks"}); err != nil {
		return err
	}
	if c.Protocol == "trojan" {
		if c.Password == "" || c.UUID != "" || c.Username != "" || c.Method != "" || c.Flow != "" || c.PacketEncoding != "" {
			return fmt.Errorf("Trojan requires password and no VLESS/cipher fields")
		}
		if c.TLS == nil || !c.TLS.Enabled || c.TLS.Reality != nil {
			return fmt.Errorf("Trojan requires ordinary TLS")
		}
	} else if !uuidPattern.MatchString(c.UUID) || c.Username != "" || c.Password != "" || c.Method != "" {
		return fmt.Errorf("VLESS requires UUID and no password/cipher fields")
	}
	if c.Protocol == "vmess" {
		if c.Flow != "" || c.TLS != nil && c.TLS.Reality != nil {
			return fmt.Errorf("VMess does not support VLESS flow or REALITY")
		}
		switch c.VMessSecurity {
		case "", "auto", "aes-128-gcm", "chacha20-poly1305", "none", "zero":
		default:
			return fmt.Errorf("unsupported VMess security")
		}
	}
	if c.PacketEncoding != "" && c.PacketEncoding != "xudp" && c.PacketEncoding != "packetaddr" {
		return fmt.Errorf("unsupported packet encoding")
	}
	if c.Flow != "" && c.Flow != "xtls-rprx-vision" {
		return fmt.Errorf("unsupported VLESS flow")
	}
	transport := "tcp"
	if c.Transport != nil {
		t := c.Transport
		transport = t.Type
		if err := validateTransportHeaders(t.Headers); err != nil {
			return err
		}
		if len(t.Authority) > 1024 || strings.ContainsAny(t.Authority, "/\\?#@") || strings.IndexFunc(t.Authority, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
			return fmt.Errorf("invalid gRPC authority")
		}
		switch t.Type {
		case "tcp":
			if t.Path != "" || t.Host != "" || t.ServiceName != "" || t.Authority != "" || len(t.Headers) > 0 {
				return fmt.Errorf("TCP transport cannot have HTTP or gRPC fields")
			}
		case "ws", "httpupgrade":
			if t.ServiceName != "" || t.Authority != "" || strings.ContainsAny(t.Path, "\r\n") || strings.ContainsAny(t.Host, "\r\n/") {
				return fmt.Errorf("invalid HTTP transport fields")
			}
		case "grpc":
			if t.Path != "" || t.Host != "" || len(t.Headers) > 0 {
				return fmt.Errorf("gRPC transport accepts service name, not path or host")
			}
		default:
			return fmt.Errorf("unsupported VLESS transport")
		}
	}
	if c.Flow != "" && (transport != "tcp" || c.TLS == nil || !c.TLS.Enabled) {
		return fmt.Errorf("Vision flow requires TCP with TLS or REALITY")
	}
	if c.TLS != nil {
		t := c.TLS
		if !t.Enabled && (t.ServerName != "" || t.Fingerprint != "" || len(t.ALPN) > 0 || t.Reality != nil) {
			return fmt.Errorf("disabled TLS contains active security fields")
		}
		if strings.ContainsAny(t.ServerName, " /\r\n") {
			return fmt.Errorf("invalid TLS server name")
		}
		if t.Reality != nil {
			key, err := base64.RawURLEncoding.DecodeString(t.Reality.PublicKey)
			if err != nil || len(key) != 32 {
				return fmt.Errorf("REALITY public key must be 32 base64url bytes")
			}
			short, err := hex.DecodeString(t.Reality.ShortID)
			if err != nil || len(short) > 8 {
				return fmt.Errorf("REALITY short ID must be up to 8 hexadecimal bytes")
			}
			if t.Fingerprint == "" || t.ServerName == "" {
				return fmt.Errorf("REALITY requires explicit server name and fingerprint")
			}
		}
	}
	return nil
}

func ValidateFilter(f EndpointFilter) error {
	if f.NamePattern != "" {
		if _, err := regexp.Compile(f.NamePattern); err != nil {
			return fmt.Errorf("invalid name regular expression")
		}
	}
	return nil
}
func MatchesEndpoint(e ClientEndpoint, f EndpointFilter) bool {
	if f.NamePattern != "" {
		r, err := regexp.Compile(f.NamePattern)
		if err != nil || !r.MatchString(e.Name) {
			return false
		}
	}
	if f.Protocol != "" && f.Protocol != e.Connection.Protocol || f.Region != "" && f.Region != e.Region {
		return false
	}
	for _, tag := range f.Tags {
		found := false
		for _, v := range e.Tags {
			if v == tag {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if f.SourceID != "" {
		found := false
		for _, p := range e.Provenance {
			if p.SourceID == f.SourceID {
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

// ProfileActionLocation identifies the editable action by stable identity, not
// its current list position. A default action has no ID.
type ProfileActionLocation struct {
	Kind string
	ID   string
}

// MissingActionReferenceError is intentionally limited to valid action IDs
// absent from this profile. Other validation failures retain their own errors.
type MissingActionReferenceError struct {
	Reference ActionRef
	Location  ProfileActionLocation
}

func (e *MissingActionReferenceError) Error() string {
	return e.Reference.Kind + " reference missing"
}

func ValidateClientProfile(p ClientProfileIR) error {
	if p.SchemaVersion != "1.0" {
		return fmt.Errorf("schemaVersion: unsupported client IR version")
	}
	if !ValidID(p.ID) || !ValidID(p.OwnerID) || strings.TrimSpace(p.Name) == "" || p.Revision == "" {
		return fmt.Errorf("profile identity, owner, name and revision required")
	}
	endpoints := map[string]bool{}
	groups := map[string]PolicyGroup{}
	resources := map[string]bool{}
	names := []NamedIdentity{}
	for i, e := range p.Endpoints {
		if e.OwnerID != p.OwnerID {
			return fmt.Errorf("endpoints[%d]: owner mismatch", i)
		}
		if e.Origin != "imported" && e.Origin != "platform-entry" {
			return fmt.Errorf("endpoints[%d]: internal or unknown origin cannot be exported", i)
		}
		if err := ValidateConnection(e.Connection); err != nil {
			return fmt.Errorf("endpoints[%d].connection: %w", i, err)
		}
		endpoints[e.ID] = true
		names = append(names, NamedIdentity{e.ID, e.Name})
	}
	for _, g := range p.Groups {
		groups[g.ID] = g
		names = append(names, NamedIdentity{g.ID, g.Name})
	}
	if _, err := StableNames(names); err != nil {
		return err
	}
	for i, r := range p.Resources {
		if !ValidID(r.ID) || resources[r.ID] {
			return fmt.Errorf("resources[%d]: invalid or duplicate identity", i)
		}
		resources[r.ID] = true
		if r.OwnerID != "" && r.OwnerID != p.OwnerID {
			return fmt.Errorf("resources[%d]: owner mismatch", i)
		}
		if err := ValidateRuleResource(r); err != nil {
			return fmt.Errorf("resources[%d]: %w", i, err)
		}
	}
	validateAction := func(a ActionRef, location ProfileActionLocation) error {
		switch a.Kind {
		case "endpoint":
			if !endpoints[a.Ref] {
				if !ValidID(a.Ref) {
					return fmt.Errorf("endpoint reference missing")
				}
				return &MissingActionReferenceError{Reference: a, Location: location}
			}
		case "group":
			if _, ok := groups[a.Ref]; !ok {
				if !ValidID(a.Ref) {
					return fmt.Errorf("group reference missing")
				}
				return &MissingActionReferenceError{Reference: a, Location: location}
			}
		case "direct", "reject":
			if a.Ref != "" {
				return fmt.Errorf("built-in action must not have reference")
			}
		default:
			return fmt.Errorf("unknown action kind")
		}
		return nil
	}
	for i, g := range p.Groups {
		switch g.Kind {
		case "manual", "url-test", "fallback", "load-balance":
		default:
			return fmt.Errorf("groups[%d]: unknown strategy", i)
		}
		if g.Dynamic != nil {
			if err := ValidateFilter(*g.Dynamic); err != nil {
				return fmt.Errorf("groups[%d].dynamic: %w", i, err)
			}
		}
		members := ResolveGroupMembers(g, p.Endpoints)
		if len(members) == 0 {
			return fmt.Errorf("groups[%d]: no members after selection", i)
		}
		for _, m := range members {
			if m.Kind == "reject" {
				return fmt.Errorf("groups[%d]: reject is not a connection member", i)
			}
			if err := validateAction(m, ProfileActionLocation{Kind: "group", ID: g.ID}); err != nil {
				return fmt.Errorf("groups[%d]: %w", i, err)
			}
		}
		if g.Kind != "manual" {
			u, err := url.Parse(g.TestURL)
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
				return fmt.Errorf("groups[%d]: explicit HTTPS test URL required", i)
			}
			if g.IntervalSeconds < 1 {
				return fmt.Errorf("groups[%d]: positive test interval required", i)
			}
		}
		if g.ToleranceMS < 0 || g.ToleranceMS > 65535 {
			return fmt.Errorf("groups[%d]: tolerance out of range", i)
		}
		if g.Kind == "load-balance" && g.Strategy != "consistent-hashing" && g.Strategy != "round-robin" && g.Strategy != "sticky-sessions" {
			return fmt.Errorf("groups[%d]: explicit supported balancing strategy required", i)
		}
	}
	state := map[string]int{}
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("group cycle at %s", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		for _, a := range groups[id].Members {
			if a.Kind == "group" {
				if err := visit(a.Ref); err != nil {
					return err
				}
			}
		}
		state[id] = 2
		return nil
	}
	for _, g := range p.Groups {
		if err := visit(g.ID); err != nil {
			return err
		}
	}
	if err := validateAction(p.DefaultAction, ProfileActionLocation{Kind: "default"}); err != nil {
		return fmt.Errorf("defaultAction: %w", err)
	}
	ruleIDs := map[string]bool{}
	for i, r := range p.Rules {
		if !ValidID(r.ID) || ruleIDs[r.ID] {
			return fmt.Errorf("rules[%d]: invalid or duplicate identity", i)
		}
		ruleIDs[r.ID] = true
		if err := validateAction(r.Action, ProfileActionLocation{Kind: "rule", ID: r.ID}); err != nil {
			return fmt.Errorf("rules[%d].action: %w", i, err)
		}
		if err := validateMatch(r.Match, resources, 0); err != nil {
			return fmt.Errorf("rules[%d].match: %w", i, err)
		}
	}
	return validateRuntime(p.Runtime)
}

func ResolveGroupMembers(g PolicyGroup, endpoints []ClientEndpoint) []ActionRef {
	out := append([]ActionRef{}, g.Members...)
	seen := map[ActionRef]bool{}
	unique := out[:0]
	for _, m := range out {
		if !seen[m] {
			seen[m] = true
			unique = append(unique, m)
		}
	}
	out = unique
	if g.Dynamic != nil {
		for _, e := range endpoints {
			m := ActionRef{Kind: "endpoint", Ref: e.ID}
			if MatchesEndpoint(e, *g.Dynamic) && !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	return out
}

func validateMatch(m MatchExpression, resources map[string]bool, depth int) error {
	if depth > 128 {
		return fmt.Errorf("expression exceeds safety depth limit")
	}
	switch m.Op {
	case "and", "or", "not":
		if m.Value != "" || len(m.Children) == 0 || m.Op == "not" && len(m.Children) != 1 {
			return fmt.Errorf("invalid boolean expression")
		}
		for _, child := range m.Children {
			if err := validateMatch(child, resources, depth+1); err != nil {
				return err
			}
		}
	case "domain", "domain-suffix":
		if len(m.Children) != 0 || m.Value == "" || strings.ContainsAny(m.Value, " ,\t\r\n/:()[]") {
			return fmt.Errorf("invalid domain match")
		}
	case "ip-cidr":
		if len(m.Children) != 0 {
			return fmt.Errorf("leaf match has children")
		}
		if _, err := netip.ParsePrefix(m.Value); err != nil {
			return fmt.Errorf("invalid IP prefix")
		}
	case "resource":
		if len(m.Children) != 0 || !resources[m.Value] {
			return fmt.Errorf("rule resource reference missing")
		}
	default:
		return fmt.Errorf("unknown match operator")
	}
	return nil
}

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func ValidateRuleResource(r RuleResource) error {
	if r.Visibility != "" && r.Visibility != "private" && r.Visibility != "public" {
		return fmt.Errorf("resource visibility must be public or private")
	}
	if r.Revision == "" || !digestPattern.MatchString(r.Digest) {
		return fmt.Errorf("resource revision and accepted SHA-256 digest required")
	}
	if r.UpdatePolicy != "pinned" && r.UpdatePolicy != "follow" {
		return fmt.Errorf("resource update policy required")
	}
	switch r.Location {
	case "local":
		if r.Path == "" || r.Path == "." || strings.Contains(r.Path, "\\") || path.IsAbs(r.Path) || path.Clean(r.Path) != r.Path || strings.HasPrefix(r.Path, "../") || r.URL != "" {
			return fmt.Errorf("resource path must be a safe relative path")
		}
	case "remote":
		u, err := url.Parse(r.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || r.Path != "" {
			return fmt.Errorf("resource requires an HTTPS URL without credentials or fragment")
		}
		if r.UpdatePolicy == "pinned" {
			return fmt.Errorf("pinned resources require local packaged files; remote clients cannot enforce digest")
		}
		if r.IntervalSeconds < 1 {
			return fmt.Errorf("remote resource requires positive update interval")
		}
	default:
		return fmt.Errorf("resource location must be local or remote")
	}
	return nil
}
func validateRuntime(r ClientRuntime) error {
	if r.MixedPort < 0 || r.MixedPort > 65535 {
		return fmt.Errorf("runtime.mixedPort: invalid port")
	}
	if r.DNS != nil {
		seen := map[string]bool{}
		for _, s := range r.DNS.Servers {
			if !ValidID(s.ID) || seen[s.ID] || net.ParseIP(s.Address) == nil || s.Port < 0 || s.Port > 65535 {
				return fmt.Errorf("runtime.dns: invalid resolver identity, IP or port")
			}
			seen[s.ID] = true
			switch s.Type {
			case "udp", "tcp", "tls":
			default:
				return fmt.Errorf("runtime.dns: unsupported resolver type")
			}
		}
		if !seen[r.DNS.Final] {
			return fmt.Errorf("runtime.dns: final resolver missing")
		}
	}
	if r.TUN != nil && r.TUN.Enabled {
		if len(r.TUN.Addresses) == 0 {
			return fmt.Errorf("runtime.tun: explicit interface addresses required")
		}
		for _, address := range r.TUN.Addresses {
			if _, err := netip.ParsePrefix(address); err != nil {
				return fmt.Errorf("runtime.tun: invalid interface address")
			}
		}
	}
	return nil
}

// ValidateMatch is shared by server and client scopes. Their action validators
// remain separate so a client cannot acquire server forwarding authority.
func ValidateMatch(m MatchExpression, resources []RuleResource) error {
	ids := map[string]bool{}
	for _, r := range resources {
		ids[r.ID] = true
	}
	return validateMatch(m, ids, 0)
}

// Headers remain typed intent, never an arbitrary native configuration patch.
// Host has one authoritative field and values may contain credentials.
func validateTransportHeaders(headers map[string]string) error {
	if len(headers) > 32 {
		return fmt.Errorf("too many transport headers")
	}
	seen := map[string]bool{}
	size := 0
	for key, value := range headers {
		lower := strings.ToLower(key)
		if key == "" || lower == "host" || seen[lower] {
			return fmt.Errorf("ambiguous transport header name")
		}
		switch lower {
		case "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "content-length", "transfer-encoding", "trailer":
			return fmt.Errorf("TRANSPORT_HEADER_RESERVED: core-owned handshake or framing header cannot be overridden")
		}
		seen[lower] = true
		for _, c := range key {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
				return fmt.Errorf("invalid transport header name")
			}
		}
		for _, c := range value {
			if c == '\r' || c == '\n' || c == 0 || c == 127 || c < 32 && c != '\t' {
				return fmt.Errorf("invalid transport header value")
			}
		}
		size += len(key) + len(value)
		if size > 8192 {
			return fmt.Errorf("transport headers exceed size limit")
		}
	}
	return nil
}
