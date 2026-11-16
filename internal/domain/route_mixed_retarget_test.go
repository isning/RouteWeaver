package domain_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"testing"
)

func TestMixedRetargetDomainPreservesScopedPrefix(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-via", "missing-prefix", "external-tail", "extra-managed", "wrong-principal"} {
		t.Run(mode, func(t *testing.T) {
			old := domain.Connection{Protocol: "vless", Host: "10.0.0.2", Port: 443, UUID: "11111111-1111-4111-8111-111111111111"}
			next := domain.Connection{Protocol: "vless", Host: "10.0.0.3", Port: 443, UUID: "22222222-2222-4222-8222-222222222222"}
			prefix := domain.ServerConnector{ID: "prefix", Connection: domain.Connection{Protocol: "socks", Host: "private.example", Port: 1080, Password: "keep-original"}}
			ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", Programs: []domain.ServerProgram{{Instance: domain.CoreInstance{ID: "entry-core", AdapterID: "routeweaver/managed-xray"}, Listener: domain.ManagedEndpoint{ID: "entry", InstanceID: "entry-core"}, Connectors: []domain.ServerConnector{prefix, {ID: "terminal", Via: "prefix", Connection: old}}, DefaultAction: domain.ActionRef{Kind: "forward", Ref: "terminal"}, Principals: []domain.ServerPrincipal{{SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", Action: domain.ActionRef{Kind: "forward", Ref: "terminal"}}}}, {Instance: domain.CoreInstance{ID: "old-core"}, Listener: domain.ManagedEndpoint{ID: "old", InstanceID: "old-core", Connection: old}, DefaultAction: domain.ActionRef{Kind: "direct"}}}}
			route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", EndpointIDs: []string{"entry", "old"}, Path: domain.RoutePath{Entry: "entry", Exit: "old"}, Hops: []domain.PublishedRouteHop{{Kind: "managed", EndpointID: "entry"}, {Kind: "connector", ConnectorID: "prefix"}, {Kind: "managed", EndpointID: "old"}}}
			target := domain.ServerProgram{Instance: domain.CoreInstance{ID: "new-core"}, Listener: domain.ManagedEndpoint{ID: "new", InstanceID: "new-core", Connection: next}, DefaultAction: domain.ActionRef{Kind: "direct"}}
			switch mode {
			case "wrong-via":
				ir.Programs[0].Connectors[0].Via = "terminal"
			case "missing-prefix":
				ir.Programs[0].Connectors = ir.Programs[0].Connectors[1:]
			case "external-tail":
				route.Hops = append(route.Hops, domain.PublishedRouteHop{Kind: "connector", ConnectorID: "tail"})
			case "extra-managed":
				route.EndpointIDs = []string{"entry", "middle", "old"}
			case "wrong-principal":
				ir.Programs[0].Principals[0].Action = domain.ActionRef{Kind: "direct"}
			}
			original, _ := json.Marshal(ir)
			oldRoute, _ := json.Marshal(route)
			got, err := domain.RetargetManagedExit(ir, route, target, next, "new-terminal", "new-revision")
			if mode != "valid" {
				if err == nil {
					t.Fatal("unsupported mixed shape accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				p := got.IR.Programs[0]
				if !reflect.DeepEqual(p.Connectors[:2], ir.Programs[0].Connectors) || p.Connectors[2].Via != "prefix" || p.DefaultAction != ir.Programs[0].DefaultAction {
					t.Fatal("shared prefix/fallback changed")
				}
				principal := ir.Programs[0].Principals[0]
				principal.Action = domain.ActionRef{Kind: "forward", Ref: "new-terminal"}
				if !reflect.DeepEqual(principal, p.Principals[0]) || got.Route.Hops[1] != route.Hops[1] || got.Route.Hops[2].EndpointID != "new" {
					t.Fatal("credential/metering identity or full hops changed")
				}
			}
			after, _ := json.Marshal(ir)
			afterRoute, _ := json.Marshal(route)
			if string(original) != string(after) || string(oldRoute) != string(afterRoute) {
				t.Fatal("input mutated")
			}
		})
	}
}
