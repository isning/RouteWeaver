package domain

// Connection is a resolved connection value. Credentials are only materialized
// for authorized export, never used as identity or included in diagnostics.
type Connection struct {
	Host           string            `json:"host"`
	Port           int               `json:"port"`
	Protocol       string            `json:"protocol"`
	Username       string            `json:"username,omitempty"`
	Password       string            `json:"password,omitempty"`
	Method         string            `json:"method,omitempty"`
	UUID           string            `json:"uuid,omitempty"`
	Flow           string            `json:"flow,omitempty"`
	TLS            *TLSOptions       `json:"tls,omitempty"`
	Transport      *TransportOptions `json:"transport,omitempty"`
	VMessSecurity  string            `json:"vmessSecurity,omitempty"`
	PacketEncoding string            `json:"packetEncoding,omitempty"`
}

type SourceRef struct {
	SourceName string `json:"sourceName,omitempty"`
	SourceID   string `json:"sourceId"`
	SnapshotID string `json:"snapshotId"`
	EndpointID string `json:"endpointId"`
}

type ClientEndpoint struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	OwnerID string `json:"ownerId"`
	// Origin is imported or platform-entry. Internal transit endpoints are never client input.
	Origin     string      `json:"origin"`
	Connection Connection  `json:"connection"`
	Provenance []SourceRef `json:"provenance,omitempty"`
	Region     string      `json:"region,omitempty"`
	Tags       []string    `json:"tags,omitempty"`
}

type SourceSnapshot struct {
	SourceName string           `json:"sourceName,omitempty"`
	SourceID   string           `json:"sourceId"`
	SnapshotID string           `json:"snapshotId"`
	OwnerID    string           `json:"ownerId"`
	Endpoints  []ClientEndpoint `json:"endpoints"`
}

type EndpointFilter struct {
	NamePattern string   `json:"namePattern,omitempty"`
	Protocol    string   `json:"protocol,omitempty"`
	Region      string   `json:"region,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	SourceID    string   `json:"sourceId,omitempty"`
}

type EndpointOverride struct {
	Region *string   `json:"region,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
	Host   *string   `json:"host,omitempty"`
	Port   *int      `json:"port,omitempty"`
}

type ProcessingStep struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	// keep, drop, rename, sort, deduplicate, override.
	Kind       string           `json:"kind"`
	Filter     EndpointFilter   `json:"filter,omitempty"`
	Template   string           `json:"template,omitempty"`
	SortBy     string           `json:"sortBy,omitempty"`
	Descending bool             `json:"descending,omitempty"`
	Override   EndpointOverride `json:"override,omitempty"`
}

type CollectionSource struct {
	SourceID string           `json:"sourceId"`
	Steps    []ProcessingStep `json:"steps"`
}

type Collection struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	OwnerID string             `json:"ownerId"`
	Sources []CollectionSource `json:"sources"`
	Steps   []ProcessingStep   `json:"steps"`
}

// ActionRef uses stable IDs, never display names. Kind is endpoint, group,
// direct, or reject. The latter two must have an empty Ref.
type ActionRef struct {
	Kind string `json:"kind"`
	Ref  string `json:"ref,omitempty"`
}

type PolicyGroup struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Kind            string          `json:"kind"` // manual, url-test, fallback, load-balance
	Members         []ActionRef     `json:"members"`
	Dynamic         *EndpointFilter `json:"dynamic,omitempty"`
	TestURL         string          `json:"testUrl,omitempty"`
	IntervalSeconds int             `json:"intervalSeconds,omitempty"`
	ToleranceMS     int             `json:"toleranceMs,omitempty"`
	Strategy        string          `json:"strategy,omitempty"`
}

// MatchExpression has one operator. Boolean children are ordered; leaf values
// are never approximated by an adapter. resource uses a stable RuleResource ID.
type MatchExpression struct {
	Op       string            `json:"op"` // domain, domain-suffix, ip-cidr, resource, and, or, not
	Value    string            `json:"value,omitempty"`
	Children []MatchExpression `json:"children,omitempty"`
}

type PolicyRule struct {
	ID     string          `json:"id"`
	Match  MatchExpression `json:"match"`
	Action ActionRef       `json:"action"`
}

// RuleResource is a frozen external file descriptor, not expanded rule data.
// Digest identifies accepted bytes in the control plane. It does not claim the
// receiving client enforces that digest. Pinned resources must use bundled files.
type RuleResource struct {
	AcceptedVersion string `json:"acceptedVersion,omitempty"` // server-accepted immutable file version
	SizeBytes       int64  `json:"sizeBytes,omitempty"`
	ID              string `json:"id"`
	Name            string `json:"name,omitempty"`
	OwnerID         string `json:"ownerId,omitempty"`    // record ownership, independent of delivery visibility
	Visibility      string `json:"visibility,omitempty"` // public or private; omitted means private
	Revision        string `json:"revision"`
	Digest          string `json:"digest"`
	Format          string `json:"format"` // sing-box-source, srs, mihomo-yaml, mihomo-text, mrs
	FormatVersion   int    `json:"formatVersion,omitempty"`
	Behavior        string `json:"behavior,omitempty"` // domain, ipcidr, classical for Mihomo
	Location        string `json:"location"`           // local or remote
	Path            string `json:"path,omitempty"`
	URL             string `json:"url,omitempty"`
	UpdatePolicy    string `json:"updatePolicy"` // pinned or follow
	IntervalSeconds int    `json:"intervalSeconds,omitempty"`
}

type DNSResolver struct {
	ID      string `json:"id"`
	Type    string `json:"type"`    // udp, tcp, tls
	Address string `json:"address"` // IP literal; avoids resolver bootstrap ambiguity
	Port    int    `json:"port,omitempty"`
}
type DNSIntent struct {
	Servers []DNSResolver `json:"servers"`
	Final   string        `json:"final"`
}
type TUNIntent struct {
	Enabled   bool     `json:"enabled"`
	Addresses []string `json:"addresses,omitempty"`
	AutoRoute bool     `json:"autoRoute"`
}
type ClientRuntime struct {
	MixedPort int        `json:"mixedPort,omitempty"`
	DNS       *DNSIntent `json:"dns,omitempty"`
	Sniff     bool       `json:"sniff"`
	TUN       *TUNIntent `json:"tun,omitempty"`
}
type ClientProfileIR struct {
	NativeOverride  *NativeClientOverride     `json:"nativeOverride,omitempty"`
	SchemaVersion   string                    `json:"schemaVersion"`
	ID              string                    `json:"id"`
	Name            string                    `json:"name"`
	OwnerID         string                    `json:"ownerId"`
	Revision        string                    `json:"revision"`
	Endpoints       []ClientEndpoint          `json:"endpoints"`
	Groups          []PolicyGroup             `json:"groups"`
	Rules           []PolicyRule              `json:"rules"`
	Resources       []RuleResource            `json:"resources"`
	DefaultAction   ActionRef                 `json:"defaultAction"`
	Runtime         ClientRuntime             `json:"runtime"`
	NameAllocations map[string]NameAllocation `json:"nameAllocations,omitempty"`
}

// TLSOptions contains client-side verification and camouflage intent only.
// Server key/certificate material belongs to the separate server program.
type TLSOptions struct {
	Enabled     bool            `json:"enabled"`
	ServerName  string          `json:"serverName,omitempty"`
	Fingerprint string          `json:"fingerprint,omitempty"`
	ALPN        []string        `json:"alpn,omitempty"`
	Reality     *RealityOptions `json:"reality,omitempty"`
}
type RealityOptions struct {
	PublicKey string `json:"publicKey"`
	ShortID   string `json:"shortId"`
}
type TransportOptions struct {
	Headers     map[string]string `json:"headers,omitempty"`
	Authority   string            `json:"authority,omitempty"`
	Type        string            `json:"type"`
	Path        string            `json:"path,omitempty"`
	Host        string            `json:"host,omitempty"`
	ServiceName string            `json:"serviceName,omitempty"`
}
