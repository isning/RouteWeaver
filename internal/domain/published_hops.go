package domain

import "fmt"

// PublishedRouteHop describes a physical proxy hop without authentication
// material. Connector IDs are scoped to the nearest preceding managed endpoint's
// server program, never to a tenant's private sources or client nodes.
type PublishedRouteHop struct {
	Kind        string `json:"kind"`
	EndpointID  string `json:"endpointId,omitempty"`
	ConnectorID string `json:"connectorId,omitempty"`
}

// HasExternalHops reports explicit connector intent; it does not validate the
// route. Call ResolvePublishedRouteHops before proving or publishing a path.
func HasExternalHops(route PublishedRoute) bool {
	for _, hop := range route.Hops {
		if hop.Kind == "connector" {
			return true
		}
	}
	return false
}

// ResolvePublishedRouteHops returns an independent canonical path. Legacy paths
// omit Hops and are expanded from EndpointIDs. EndpointIDs and Path remain the
// managed projection: Path.Exit is not necessarily the physical final proxy.
// This validates path structure only; callers must prove connectors and native
// forwarding against the owning deployment before publication.
func ResolvePublishedRouteHops(route PublishedRoute) ([]PublishedRouteHop, error) {
	if len(route.EndpointIDs) == 0 || len(route.EndpointIDs) > 32 {
		return nil, fmt.Errorf("published path requires 1 to 32 managed endpoints")
	}
	if len(route.Hops) > 64 {
		return nil, fmt.Errorf("published path exceeds 64 hops")
	}
	hops := append([]PublishedRouteHop(nil), route.Hops...)
	if len(hops) == 0 {
		for _, id := range route.EndpointIDs {
			hops = append(hops, PublishedRouteHop{Kind: "managed", EndpointID: id})
		}
	}
	if hops[0].Kind != "managed" {
		return nil, fmt.Errorf("published path must start at a managed endpoint")
	}
	seenManaged := map[string]bool{}
	seenConnectors := map[string]bool{}
	managed := 0
	for _, hop := range hops {
		switch hop.Kind {
		case "managed":
			if !ValidID(hop.EndpointID) || hop.ConnectorID != "" {
				return nil, fmt.Errorf("managed hop requires only an endpoint identity")
			}
			if seenManaged[hop.EndpointID] {
				return nil, fmt.Errorf("published path repeats a managed endpoint")
			}
			if managed >= len(route.EndpointIDs) || route.EndpointIDs[managed] != hop.EndpointID {
				return nil, fmt.Errorf("published path managed projection differs from endpoint identities")
			}
			seenManaged[hop.EndpointID] = true
			managed++
			seenConnectors = map[string]bool{}
		case "connector":
			if !ValidID(hop.ConnectorID) || hop.EndpointID != "" {
				return nil, fmt.Errorf("connector hop requires only a connector identity")
			}
			if seenConnectors[hop.ConnectorID] {
				return nil, fmt.Errorf("published path repeats a connector within its managed program")
			}
			seenConnectors[hop.ConnectorID] = true
		default:
			return nil, fmt.Errorf("unsupported published hop kind")
		}
	}
	if managed != len(route.EndpointIDs) {
		return nil, fmt.Errorf("published path managed projection differs from endpoint identities")
	}
	if route.Path.Entry != route.EndpointIDs[0] || route.Path.Exit != route.EndpointIDs[managed-1] {
		return nil, fmt.Errorf("published path entry and exit differ from its managed projection")
	}
	return hops, nil
}
