package domain

import "fmt"

// A physical host, running instance, and listening endpoint are different identities.
type Host struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Address string   `json:"address"`
	Group   string   `json:"group,omitempty"`
	Tags    []string `json:"tags,omitempty"`
}
type CoreInstance struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	HostID    string `json:"hostId"`
	AdapterID string `json:"adapterId"`
	Version   string `json:"version"`
}
type ManagedEndpoint struct {
	Authentication string     `json:"authentication,omitempty"`
	ID             string     `json:"id"`
	InstanceID     string     `json:"instanceId"`
	Name           string     `json:"name"`
	Connection     Connection `json:"connection"`
}
type Link struct {
	ID   string `json:"id"`
	From string `json:"from"`
	To   string `json:"to"`
}
type RouteGraph struct {
	Endpoints []ManagedEndpoint `json:"endpoints"`
	Links     []Link            `json:"links"`
}
type RoutePath struct {
	ID    string   `json:"id"`
	Entry string   `json:"entry"`
	Exit  string   `json:"exit"`
	Links []string `json:"links"`
}

// ResolvePath validates all inventory references and follows exactly the
// selected simple path. Alternative reverse links may coexist in inventory;
// only a selected route that repeats an endpoint is a forwarding loop.
func ResolvePath(g RouteGraph, p RoutePath) ([]ManagedEndpoint, error) {
	endpoints := map[string]ManagedEndpoint{}
	edges := map[string]Link{}
	for _, e := range g.Endpoints {
		if !ValidID(e.ID) || endpoints[e.ID].ID != "" {
			return nil, fmt.Errorf("endpoint identity invalid or repeated")
		}
		endpoints[e.ID] = e
	}
	for _, l := range g.Links {
		if !ValidID(l.ID) || edges[l.ID].ID != "" {
			return nil, fmt.Errorf("link identity invalid or repeated")
		}
		if endpoints[l.From].ID == "" || endpoints[l.To].ID == "" {
			return nil, fmt.Errorf("link %s references missing endpoint", l.ID)
		}
		edges[l.ID] = l
	}
	if !ValidID(p.ID) || endpoints[p.Entry].ID == "" || endpoints[p.Exit].ID == "" {
		return nil, fmt.Errorf("route identity, entry and exit required")
	}
	current := p.Entry
	seen := map[string]bool{current: true}
	result := []ManagedEndpoint{endpoints[current]}
	for _, id := range p.Links {
		l, ok := edges[id]
		if !ok || l.From != current {
			return nil, fmt.Errorf("route link %s is missing or disconnected", id)
		}
		current = l.To
		if seen[current] {
			return nil, fmt.Errorf("selected route contains cycle at %s", current)
		}
		seen[current] = true
		result = append(result, endpoints[current])
	}
	if current != p.Exit {
		return nil, fmt.Errorf("route does not reach explicit exit")
	}
	return result, nil
}

// ServerDeploymentIR cannot be built by the client renderer. A
// program supports one listener with explicit principals or legacy authentication and named connector policies per
// instance, with an adapter for legacy ordered egress. It does not execute deployment.
type ServerProgram struct {
	DestinationPolicy *DestinationPolicy `json:"destinationPolicy,omitempty"`
	Principals        []ServerPrincipal  `json:"principals,omitempty"`
	Instance          CoreInstance       `json:"instance"`
	Listener          ManagedEndpoint    `json:"listener"`
	Egress            []Connection       `json:"egress"`
	Rules             []PolicyRule       `json:"rules"`
	Resources         []RuleResource     `json:"resources"`
	TLS               *ServerTLSOptions  `json:"tls,omitempty"`
	DefaultAction     ActionRef          `json:"defaultAction,omitempty"`
	Connectors        []ServerConnector  `json:"connectors,omitempty"`
}
type ServerDeploymentIR struct {
	SchemaVersion    string          `json:"schemaVersion"`
	ID               string          `json:"id"`
	TopologyRevision string          `json:"topologyRevision"`
	Programs         []ServerProgram `json:"programs"`
}

// ServerTLSOptions is deliberately absent from client profile IR. Secret paths
// are scoped to the target's restricted resource package, not a host secret store.
type ServerTLSOptions struct {
	CertificatePEM  string                `json:"certificatePem,omitempty"`
	PrivateKeyPEM   string                `json:"privateKeyPem,omitempty"`
	CertificatePath string                `json:"certificatePath,omitempty"`
	KeyPath         string                `json:"keyPath,omitempty"`
	Reality         *ServerRealityOptions `json:"reality,omitempty"`
}
type ServerRealityOptions struct {
	PrivateKey      string   `json:"privateKey"`
	HandshakeServer string   `json:"handshakeServer"`
	HandshakePort   int      `json:"handshakePort"`
	ShortIDs        []string `json:"shortIds"`
	ServerNames     []string `json:"serverNames"`
}

// ServerConnector has a stable identity and optional upstream connector. It is
// administrator intent, never included in a ClientProfileIR.
type ServerConnector struct {
	ID         string     `json:"id"`
	Connection Connection `json:"connection"`
	Via        string     `json:"via,omitempty"`
}
