package httpapi

import (
	"fmt"
	"reflect"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// Explicit hops are a complete declaration, not permission to read a private
// source. Every connector resolves inside the preceding administrator program.
func verifyExplicitPublishedPath(ir domain.ServerDeploymentIR, route domain.PublishedRoute, endpoints []domain.ManagedEndpoint, dials []domain.Connection) (domain.ActionRef, error) {
	hops, err := domain.ResolvePublishedRouteHops(route)
	if err != nil {
		return domain.ActionRef{}, err
	}
	if ir.ID != route.DeploymentID || len(endpoints) != len(route.EndpointIDs) || len(dials) != len(endpoints) {
		return domain.ActionRef{}, fmt.Errorf("selected path deployment or managed projection differs")
	}
	programs := map[string]domain.ServerProgram{}
	instances := map[string]bool{}
	for _, p := range ir.Programs {
		if programs[p.Listener.ID].Listener.ID != "" || instances[p.Instance.ID] {
			return domain.ActionRef{}, fmt.Errorf("selected path has ambiguous deployment programs")
		}
		programs[p.Listener.ID] = p
		instances[p.Instance.ID] = true
	}
	var entryAction domain.ActionRef
	position := 0
	for i, endpoint := range endpoints {
		if endpoint.ID != route.EndpointIDs[i] || hops[position].EndpointID != endpoint.ID {
			return entryAction, fmt.Errorf("selected path endpoint order differs")
		}
		p, ok := programs[endpoint.ID]
		if !ok || p.Listener.InstanceID != endpoint.InstanceID || !sameListenerNetwork(p.Listener.Connection, endpoint.Connection) {
			return entryAction, fmt.Errorf("selected endpoint has no matching deployment listener")
		}
		if i > 0 && len(p.Principals) > 0 || len(p.Rules) > 0 {
			return entryAction, fmt.Errorf("selected path requires unconditional transit without per-user branches")
		}
		connectors, defaultAction, err := publishedProgramConnectors(p)
		if err != nil {
			return entryAction, err
		}
		position++
		previous := ""
		for position < len(hops) && hops[position].Kind == "connector" {
			id := hops[position].ConnectorID
			connector, exists := connectors[id]
			if !exists || connector.Via != previous {
				return entryAction, fmt.Errorf("selected connector is missing, reordered or has a hidden detour")
			}
			previous = id
			position++
		}
		selected := domain.ActionRef{Kind: "direct"}
		if i+1 < len(endpoints) {
			matches := 0
			for _, connector := range connectors {
				if connector.Via == previous && reflect.DeepEqual(connector.Connection, dials[i+1]) {
					matches++
					selected = domain.ActionRef{Kind: "forward", Ref: connector.ID}
				}
			}
			if matches != 1 {
				return entryAction, fmt.Errorf("selected path requires exactly one matching managed next-hop connector")
			}
		} else if previous != "" {
			selected = domain.ActionRef{Kind: "forward", Ref: previous}
		}
		// Only a managed ingress may select a route by principal instead of
		// its global fallback. Every later program must actually take this path.
		if !(i == 0 && p.Instance.AdapterID == render.ServerAdapterManagedXray) && defaultAction != selected {
			return entryAction, fmt.Errorf("selected path does not match the deployed forwarding action")
		}
		if i == 0 {
			entryAction = selected
		}
	}
	return entryAction, nil
}

func publishedProgramConnectors(p domain.ServerProgram) (map[string]domain.ServerConnector, domain.ActionRef, error) {
	connectors := map[string]domain.ServerConnector{}
	selected := p.DefaultAction
	if len(p.Egress) > 0 && len(p.Connectors) > 0 {
		return nil, selected, fmt.Errorf("selected path has ambiguous connector contracts")
	}
	if len(p.Egress) > 0 {
		for i, connection := range p.Egress {
			id, via := fmt.Sprintf("egress-%d", i+1), ""
			if i > 0 {
				via = fmt.Sprintf("egress-%d", i)
			}
			connectors[id] = domain.ServerConnector{ID: id, Connection: connection, Via: via}
		}
		if selected.Kind == "" {
			selected = domain.ActionRef{Kind: "forward", Ref: fmt.Sprintf("egress-%d", len(p.Egress))}
		}
	} else {
		for _, connector := range p.Connectors {
			if !domain.ValidID(connector.ID) || connector.ID == "rw-direct" || connector.ID == "rw-reject" || connectors[connector.ID].ID != "" {
				return nil, selected, fmt.Errorf("selected path has invalid or repeated connector identities")
			}
			connectors[connector.ID] = connector
		}
		if selected.Kind == "" {
			if len(connectors) > 0 {
				return nil, selected, fmt.Errorf("named connectors require an explicit default action")
			}
			selected = domain.ActionRef{Kind: "direct"}
		}
	}
	state := map[string]int{}
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 2 {
			return nil
		}
		next, ok := connectors[id]
		if !ok || state[id] == 1 {
			return fmt.Errorf("selected path contains a missing connector or cycle")
		}
		state[id] = 1
		if next.Via != "" {
			if err := visit(next.Via); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for _, connector := range connectors {
		if err := domain.ValidateConnection(connector.Connection); err != nil {
			return nil, selected, fmt.Errorf("selected path contains an invalid connector connection")
		}
		if err := visit(connector.ID); err != nil {
			return nil, selected, err
		}
	}
	return connectors, selected, nil
}

func samePublishedRouteSnapshot(a, b domain.PublishedRoute) bool {
	left, leftErr := domain.ResolvePublishedRouteHops(a)
	right, rightErr := domain.ResolvePublishedRouteHops(b)
	if leftErr != nil || rightErr != nil {
		return false
	}
	a.Hops, b.Hops = left, right
	return reflect.DeepEqual(a, b)
}
