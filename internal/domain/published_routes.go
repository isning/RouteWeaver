package domain

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// PublishedRoute is a stable service-facing identity for a managed server path.
// It is not a client chain and never contains transit authentication material.
type PublishedRoute struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	DeploymentID string              `json:"deploymentId"`
	Path         RoutePath           `json:"path"`
	EndpointIDs  []string            `json:"endpointIds"`
	Hops         []PublishedRouteHop `json:"hops,omitempty"`
	PublicHost   string              `json:"publicHost"`
	PublicPort   int                 `json:"publicPort"`
}

// PrincipalCredential is deliberately separate from listener transport/security.
type PrincipalCredential struct {
	UUID     string `json:"uuid,omitempty"`
	Password string `json:"password,omitempty"`
	Username string `json:"username,omitempty"`
	Flow     string `json:"flow,omitempty"`
}

func PrincipalCredentialFields(protocol string) (uuid, password bool) {
	switch protocol {
	case "vless", "vmess":
		return true, false
	case "trojan", "hysteria2", "anytls", "socks", "shadowsocks":
		return false, true
	case "tuic":
		return true, true
	default:
		return false, false
	}
}

// ShadowsocksUserKeySize is the key size for the supported SS2022 identity-header ciphers.
func ShadowsocksUserKeySize(method string) int {
	switch method {
	case "2022-blake3-aes-128-gcm":
		return 16
	case "2022-blake3-aes-256-gcm":
		return 32
	default:
		return 0
	}
}

func validatePrincipalListenerAuth(c Connection) error {
	uuid, password := PrincipalCredentialFields(c.Protocol)
	if (!uuid && !password) || c.UUID != "" || c.Flow != "" || c.Username != "" {
		return fmt.Errorf("invalid principal listener authentication")
	}
	if c.Protocol == "shadowsocks" {
		if ShadowsocksUserKeySize(c.Method) == 0 || strings.Contains(c.Password, ":") {
			return fmt.Errorf("Shadowsocks user credentials require an SS2022 AES cipher and one endpoint key")
		}
		return ValidateConnection(c)
	}
	if c.Password != "" || c.Method != "" {
		return fmt.Errorf("listener authentication and principals are mutually exclusive")
	}
	return nil
}

func principalConnection(c Connection, credential PrincipalCredential) (Connection, error) {
	uuid, password := PrincipalCredentialFields(c.Protocol)
	if (!uuid && !password) || uuid != (credential.UUID != "") || password != (credential.Password != "") || (c.Protocol != "vless" && credential.Flow != "") || (c.Protocol == "socks") != (credential.Username != "") {
		return Connection{}, fmt.Errorf("credential fields do not match the listener protocol")
	}
	if c.Protocol == "shadowsocks" {
		if err := validatePrincipalListenerAuth(c); err != nil {
			return Connection{}, err
		}
		if credential.Password == c.Password || strings.Contains(credential.Password, ":") {
			return Connection{}, fmt.Errorf("Shadowsocks requires a separate user key")
		}
		c.Password += ":" + credential.Password
	} else {
		c.UUID, c.Flow, c.Password, c.Username = credential.UUID, credential.Flow, credential.Password, credential.Username
	}
	return c, ValidateConnection(c)
}

// ServerPrincipal binds an opaque authenticated native identity to control-plane
// identities. Only administrator operations may create this mapping; no client
// supplied routing or account label is trusted by the managed runtime.
type ServerPrincipal struct {
	SubjectID         string              `json:"subjectId"`
	AccountID         string              `json:"accountId"`
	RouteID           string              `json:"routeId"`
	CredentialVersion string              `json:"credentialVersion"`
	Credential        PrincipalCredential `json:"credential"`
	Action            ActionRef           `json:"action"`
	PolicyRevision    string              `json:"policyRevision,omitempty"`
	CycleID           string              `json:"cycleId,omitempty"`
}

// ValidateServerListener keeps listener and user authentication separate.
// SS2022 uses the endpoint key as part of its per-user authentication.
func ValidateServerListener(p ServerProgram) error {
	if err := ValidateListenerTransport(p.Listener.Connection); err != nil {
		return err
	}
	c := p.Listener.Connection
	if c.TUIC != nil && c.TUIC.UDPRelayMode != "" {
		return fmt.Errorf("TUIC_RELAY_MODE_OUTBOUND_ONLY")
	}
	if h := c.Hysteria2; h != nil && (len(h.ServerPorts) > 0 || h.HopIntervalSeconds > 0) {
		return fmt.Errorf("HYSTERIA2_HOPPING_OUTBOUND_ONLY: listener uses a fixed port")
	}
	if p.Listener.Authentication != "" && p.Listener.Authentication != "principals" {
		return fmt.Errorf("unsupported listener authentication model")
	}
	if len(p.Principals) > 1000 {
		return fmt.Errorf("principal count exceeds verified limit")
	}
	if len(p.Principals) == 0 {
		return ValidateManagedEndpoint(p.Listener)
	}
	if err := validatePrincipalListenerAuth(c); err != nil {
		return err
	}
	subjects, credentials := map[string]bool{}, map[string]bool{}
	for i, principal := range p.Principals {
		for _, id := range []string{principal.SubjectID, principal.AccountID, principal.RouteID, principal.CredentialVersion} {
			if !ValidID(id) {
				return fmt.Errorf("principals[%d]: stable identity required", i)
			}
		}
		kind, key := "uuid", strings.ToLower(principal.Credential.UUID)
		if key == "" {
			kind, key = "password", principal.Credential.Password
		}
		if c.Protocol == "socks" {
			kind, key = "username", principal.Credential.Username
		}
		key = kind + ":" + key
		if subjects[principal.SubjectID] || credentials[key] {
			return fmt.Errorf("principal subject or credential duplicated")
		}
		subjects[principal.SubjectID], credentials[key] = true, true
		if _, err := principalConnection(c, principal.Credential); err != nil {
			return fmt.Errorf("principals[%d]: %w", i, err)
		}
	}
	return nil
}

func PublicPrincipalConnection(route PublishedRoute, listener ManagedEndpoint, principal ServerPrincipal) (Connection, error) {
	if err := ValidateListenerTransport(listener.Connection); err != nil {
		return Connection{}, err
	}
	if route.Path.Entry != listener.ID || principal.RouteID != route.ID {
		return Connection{}, fmt.Errorf("principal and published entry do not match")
	}
	if listener.Connection.Protocol == "socks" {
		address, err := netip.ParseAddr(route.PublicHost)
		if err != nil || !(address.IsPrivate() || address.IsLoopback()) {
			return Connection{}, fmt.Errorf("SOCKS user credentials require a private or loopback entry address")
		}
	}
	if err := ValidatePublishedEntrySecurity(route, listener.Connection); err != nil {
		return Connection{}, err
	}
	c := listener.Connection
	// The public connection uses this principal, plus the SS2022 endpoint key
	// when required by the client protocol. It never includes transit or TLS keys.
	c.Host, c.Port = route.PublicHost, route.PublicPort
	c.Username = ""
	return principalConnection(c, principal.Credential)
}

// DeploymentIdentity is the immutable, secret-free deployment fence. Its JSON
// fields match the control protocol without making domain depend on transport.
type DeploymentIdentity struct {
	NodeID          string `json:"nodeId"`
	InstanceID      string `json:"instanceId"`
	EnrollmentEpoch string `json:"enrollmentEpoch"`
	AdapterID       string `json:"adapterId"`
	CoreVersion     string `json:"coreVersion"`
	Generation      uint64 `json:"generation,string"`
	RevisionID      string `json:"revisionId"`
	OperationID     string `json:"operationId"`
	Digest          string `json:"digest"`
}

// PublishedManifest is written immutably for a queued target. A saved draft or
// the existence of this record alone never establishes applied credentials.
type PublishedManifest struct {
	PolicyExpiresAt time.Time          `json:"policyExpiresAt"`
	DeploymentID    string             `json:"deploymentId"`
	Fingerprint     string             `json:"fingerprint"`
	Identity        DeploymentIdentity `json:"identity"`
	Program         ServerProgram      `json:"program"`
	Routes          []PublishedRoute   `json:"routes"`
}

// ValidateManagedEndpoint validates listener inventory. Principal listeners
// cannot be exported as client connections without a particular principal.
func ValidateManagedEndpoint(endpoint ManagedEndpoint) error {
	if err := ValidateListenerTransport(endpoint.Connection); err != nil {
		return err
	}
	if endpoint.Authentication == "" {
		if endpoint.Connection.Protocol == "shadowsocks" && strings.Contains(endpoint.Connection.Password, ":") {
			return fmt.Errorf("Shadowsocks listeners require one endpoint key")
		}
		return ValidateConnection(endpoint.Connection)
	}
	if endpoint.Authentication != "principals" {
		return fmt.Errorf("unsupported endpoint authentication model")
	}
	c := endpoint.Connection
	if err := validatePrincipalListenerAuth(c); err != nil || c.Protocol == "shadowsocks" {
		return err
	}
	uuid, password := PrincipalCredentialFields(c.Protocol)
	sample := PrincipalCredential{}
	if uuid {
		sample.UUID = "00000000-0000-4000-8000-000000000000"
	}
	if password {
		sample.Password = "validation-only"
	}
	if c.Protocol == "socks" {
		sample.Username = "validation-only"
	}
	_, err := principalConnection(c, sample)
	return err
}

// ResolvePublishedPrincipal checks an immutable manifest, never a mutable
// draft. The caller must independently prove that the exact manifest Identity
// is currently observed on every endpoint in the returned route.
// ErrPublishedPrincipalNotInManifest distinguishes a valid manifest that does
// not yet contain the requested credential from an invalid manifest/connection.
var ErrPublishedPrincipalNotInManifest = errors.New("credential principal is not in the applied revision")

func ResolvePublishedPrincipal(manifest PublishedManifest, subject, account, routeID, version string) (Connection, PublishedRoute, error) {
	var route PublishedRoute
	for _, v := range manifest.Routes {
		if v.ID == routeID {
			route = v
			break
		}
	}
	if route.ID == "" || route.DeploymentID != manifest.DeploymentID || route.Path.Entry != manifest.Program.Listener.ID {
		return Connection{}, route, fmt.Errorf("applied route entry mismatch")
	}
	for _, principal := range manifest.Program.Principals {
		if principal.SubjectID == subject && principal.AccountID == account && principal.RouteID == routeID && principal.CredentialVersion == version {
			c, err := PublicPrincipalConnection(route, manifest.Program.Listener, principal)
			return c, route, err
		}
	}
	return Connection{}, route, ErrPublishedPrincipalNotInManifest
}

// DestinationPolicy controls user-requested final destinations, not the
// administrator's connector dial addresses. Missing policy denies private and
// special targets. Exceptions are explicit CIDRs, never a global off switch.
type DestinationPolicy struct {
	AllowCIDRs []string `json:"allowCidrs,omitempty"`
}

func ValidateDestinationPolicy(p *DestinationPolicy) error {
	if p == nil {
		return nil
	}
	if len(p.AllowCIDRs) > 64 {
		return fmt.Errorf("too many destination exceptions")
	}
	seen := map[string]bool{}
	for _, raw := range p.AllowCIDRs {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil || prefix != prefix.Masked() || prefix.Bits() == 0 || seen[raw] {
			return fmt.Errorf("destination exceptions must be unique canonical non-default CIDRs")
		}
		seen[raw] = true
	}
	return nil
}

// Unencrypted VLESS is supported only for an explicitly addressed trusted
// private/loopback entry, never a public DNS name or public address.
func ValidatePublishedEntrySecurity(route PublishedRoute, connection Connection) error {
	if connection.Protocol != "vless" || connection.TLS != nil && connection.TLS.Enabled {
		return nil
	}
	address, err := netip.ParseAddr(route.PublicHost)
	if err != nil || !(address.IsPrivate() || address.IsLoopback()) {
		return fmt.Errorf("public VLESS entries require TLS; unencrypted entries are restricted to explicit private or loopback IPs")
	}
	return nil
}

// ValidateListenerTransport prevents dial-only intent from being reinterpreted
// as response headers or silently ignored by a server listener. Request headers
// belong to client endpoints/connectors, not the listener's public template.
func ValidateListenerTransport(c Connection) error {
	if c.Protocol == "vmess" && c.VMessSecurity != "" && c.VMessSecurity != "auto" {
		return fmt.Errorf("VMESS_SECURITY_OUTBOUND_ONLY: listener accepts automatic security negotiation")
	}
	if c.Transport == nil {
		return nil
	}
	if len(c.Transport.Headers) > 0 {
		return fmt.Errorf("HEADERS_OUTBOUND_ONLY: request headers cannot configure a server listener")
	}
	if c.Transport.Authority != "" {
		return fmt.Errorf("GRPC_AUTHORITY_OUTBOUND_ONLY: listener authority is not enforced")
	}
	if c.Transport.Type == "ws" || c.Transport.Type == "httpupgrade" || c.Transport.Type == "xhttp" {
		path := c.Transport.Path
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		parsed, err := url.ParseRequestURI(path)
		if err != nil || strings.ContainsAny(path, "?#") || parsed.Path != path || c.Transport.Type == "ws" && parsed.EscapedPath() != path {
			return fmt.Errorf("LISTENER_PATH_UNSUPPORTED: enter a decoded path without query, fragment or percent escapes (WebSocket also requires URI-safe characters); configure request URL options on the client endpoint instead")
		}
	}
	return nil
}
