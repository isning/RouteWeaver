package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
)

// ExitRetarget is a draft transformation, never an authorization or application.
// The caller proves registered network snapshots and the complete route graph.
type ExitRetarget struct {
	IR               ServerDeploymentIR
	Route            PublishedRoute
	Link             Link
	AffectedUsers    int
	AddedProgram     bool
	LegacyNormalized bool
}

// RetargetManagedExit changes only one proven two-hop managed route. It isolates
// its principals so existing fallback, other routes and connector identities stay
// unchanged. Inputs must have passed strict supported-shape decoding.
func RetargetManagedExit(ir ServerDeploymentIR, route PublishedRoute, target ServerProgram, dial Connection, connectorID, revision string) (ExitRetarget, error) {
	var result ExitRetarget
	refuse := func() (ExitRetarget, error) {
		return result, fmt.Errorf("route exit change requires an unambiguous managed two-endpoint path")
	}
	if len(route.Hops) > 0 {
		if _, err := ResolvePublishedRouteHops(route); err != nil || HasExternalHops(route) {
			return refuse()
		}
	}
	if ir.SchemaVersion != "1.0" || route.DeploymentID != ir.ID || len(route.EndpointIDs) != 2 || route.EndpointIDs[0] != route.Path.Entry || route.EndpointIDs[1] != route.Path.Exit || !ValidID(connectorID) || !ValidID(revision) || target.Listener.ID == route.Path.Exit || target.Listener.ID == route.Path.Entry {
		return refuse()
	}
	if target.Listener.Authentication == "principals" || len(target.Principals) > 0 || len(target.Rules) > 0 || len(target.Egress) > 0 || len(target.Connectors) > 0 || (target.DefaultAction.Kind != "" && target.DefaultAction.Kind != "direct") || target.DefaultAction.Ref != "" {
		return result, fmt.Errorf("replacement requires a credential-bearing direct terminal endpoint")
	}
	// Clone only supported typed intent; strict decoding belongs to the adapter.
	raw, err := json.Marshal(ir)
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(raw, &result.IR); err != nil {
		return result, err
	}
	rr, _ := json.Marshal(route)
	_ = json.Unmarshal(rr, &result.Route)
	index := -1
	for i, p := range result.IR.Programs {
		if p.Listener.ID == route.Path.Entry {
			if index >= 0 {
				return refuse()
			}
			index = i
		}
	}
	if index < 0 {
		return refuse()
	}
	p := &result.IR.Programs[index]
	if p.Instance.AdapterID != "routeweaver/managed-xray" || len(p.Rules) > 0 {
		return refuse()
	}
	if len(p.Egress) > 0 {
		if len(p.Egress) != 1 || len(p.Connectors) > 0 {
			return refuse()
		}
		p.Connectors = []ServerConnector{{ID: "egress-1", Connection: p.Egress[0]}}
		p.Egress = nil
		if p.DefaultAction.Kind == "" {
			p.DefaultAction = ActionRef{Kind: "forward", Ref: "egress-1"}
		}
		result.LegacyNormalized = true
	}
	var old ActionRef
	users := map[string]bool{}
	for _, principal := range p.Principals {
		if principal.RouteID == route.ID {
			if old.Kind != "" && old != principal.Action {
				return refuse()
			}
			old = principal.Action
			users[principal.AccountID] = true
		}
	}
	if old.Kind != "forward" {
		return refuse()
	}
	oldFound := 0
	selected := ""
	for _, c := range p.Connectors {
		if c.ID == connectorID {
			return result, fmt.Errorf("replacement connector identity already exists")
		}
		if c.ID == old.Ref && c.Via == "" {
			oldFound++
		}
		if c.Via == "" && reflect.DeepEqual(c.Connection, dial) {
			if selected != "" {
				return result, fmt.Errorf("replacement has ambiguous matching connectors")
			}
			selected = c.ID
		}
	}
	if oldFound != 1 {
		return refuse()
	}
	if selected == "" {
		selected = connectorID
		p.Connectors = append(p.Connectors, ServerConnector{ID: selected, Connection: dial})
	}
	for i := range p.Principals {
		if p.Principals[i].RouteID == route.ID {
			p.Principals[i].Action = ActionRef{Kind: "forward", Ref: selected}
		}
	}
	found := false
	for _, existing := range result.IR.Programs {
		if existing.Listener.ID == target.Listener.ID {
			if !reflect.DeepEqual(existing, target) {
				return result, fmt.Errorf("replacement program changed")
			}
			found = true
		} else if existing.Instance.ID == target.Instance.ID {
			return result, fmt.Errorf("replacement core already has a different listener")
		}
	}
	if !found {
		result.IR.Programs = append(result.IR.Programs, target)
		result.AddedProgram = true
	}
	result.IR.TopologyRevision = revision
	result.Route.EndpointIDs[1] = target.Listener.ID
	if len(result.Route.Hops) > 0 {
		result.Route.Hops[1].EndpointID = target.Listener.ID
	}
	result.Route.Path.Exit = target.Listener.ID
	sum := sha256.Sum256([]byte(route.Path.Entry + "\x00" + target.Listener.ID))
	result.Link = Link{ID: "path_" + hex.EncodeToString(sum[:16]), From: route.Path.Entry, To: target.Listener.ID}
	result.Route.Path.Links = []string{result.Link.ID}
	result.AffectedUsers = len(users)
	return result, nil
}
