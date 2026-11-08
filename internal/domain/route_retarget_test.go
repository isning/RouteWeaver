package domain_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"testing"
)

func TestRetargetManagedExitPreservesLegacyFallbackAndOtherPrincipals(t *testing.T) {
	old := domain.Connection{Protocol: "vless", Host: "192.0.2.2", Port: 443, UUID: "11111111-1111-4111-8111-111111111111"}
	next := domain.Connection{Protocol: "vless", Host: "192.0.2.3", Port: 443, UUID: "22222222-2222-4222-8222-222222222222"}
	ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", TopologyRevision: "old", Programs: []domain.ServerProgram{
		{Instance: domain.CoreInstance{ID: "fra-core", AdapterID: "routeweaver/managed-xray"}, Listener: domain.ManagedEndpoint{ID: "fra", InstanceID: "fra-core"}, Egress: []domain.Connection{old}, Principals: []domain.ServerPrincipal{
			{SubjectID: "alice", RouteID: "route", PolicyRevision: "meter-old", CredentialVersion: "v1", Action: domain.ActionRef{Kind: "forward", Ref: "egress-1"}},
			{SubjectID: "bob", RouteID: "route", PolicyRevision: "meter-old", CredentialVersion: "v2", Action: domain.ActionRef{Kind: "forward", Ref: "egress-1"}},
			{SubjectID: "other", RouteID: "other-route", Action: domain.ActionRef{Kind: "forward", Ref: "egress-1"}},
		}},
		{Instance: domain.CoreInstance{ID: "uk-core"}, Listener: domain.ManagedEndpoint{ID: "uk", InstanceID: "uk-core", Connection: old}},
	}}
	route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", EndpointIDs: []string{"fra", "uk"}, Path: domain.RoutePath{Entry: "fra", Exit: "uk"}}
	target := domain.ServerProgram{Instance: domain.CoreInstance{ID: "new-core"}, Listener: domain.ManagedEndpoint{ID: "new-uk", InstanceID: "new-core", Connection: next}, DefaultAction: domain.ActionRef{Kind: "direct"}}
	before, _ := json.Marshal(ir)
	got, err := domain.RetargetManagedExit(ir, route, target, next, "new-out", "new-revision")
	if err != nil {
		t.Fatal(err)
	}
	p := got.IR.Programs[0]
	if len(p.Egress) != 0 || len(p.Connectors) != 2 || p.DefaultAction != (domain.ActionRef{Kind: "forward", Ref: "egress-1"}) {
		t.Fatalf("fallback lost: %#v", p)
	}
	if !reflect.DeepEqual(p.Connectors[0], domain.ServerConnector{ID: "egress-1", Connection: old}) || !reflect.DeepEqual(p.Connectors[1], domain.ServerConnector{ID: "new-out", Connection: next}) {
		t.Fatal("actual forwarding wrong")
	}
	for i := 0; i < 2; i++ {
		expected := ir.Programs[0].Principals[i]
		expected.Action = domain.ActionRef{Kind: "forward", Ref: "new-out"}
		if !reflect.DeepEqual(p.Principals[i], expected) {
			t.Fatal("identity or accounting changed")
		}
	}
	if !reflect.DeepEqual(p.Principals[2], ir.Programs[0].Principals[2]) || !reflect.DeepEqual(got.IR.Programs[1], ir.Programs[1]) {
		t.Fatal("unrelated intent changed")
	}
	if len(got.IR.Programs) != 3 || got.Route.EndpointIDs[1] != "new-uk" || got.Route.Path.Exit != "new-uk" {
		t.Fatal("target not added coherently")
	}
	after, _ := json.Marshal(ir)
	if string(before) != string(after) {
		t.Fatal("input mutated")
	}
	// The explicit managed-only representation remains compatible and is kept
	// coherent; adding an external hop must not be silently flattened.
	route.Hops = []domain.PublishedRouteHop{{Kind: "managed", EndpointID: "fra"}, {Kind: "managed", EndpointID: "uk"}}
	explicit, err := domain.RetargetManagedExit(ir, route, target, next, "new-out", "new-revision")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = domain.ResolvePublishedRouteHops(explicit.Route); err != nil || explicit.Route.Hops[1].EndpointID != "new-uk" || route.Hops[1].EndpointID != "uk" {
		t.Fatalf("explicit managed path lost coherence: %#v %v", explicit.Route.Hops, err)
	}
	route.Hops = []domain.PublishedRouteHop{{Kind: "managed", EndpointID: "fra"}, {Kind: "connector", ConnectorID: "external"}, {Kind: "managed", EndpointID: "uk"}}
	if _, err = domain.RetargetManagedExit(ir, route, target, next, "new-out", "new-revision"); err == nil {
		t.Fatal("mixed path was flattened by the managed-only exit operation")
	}
}
