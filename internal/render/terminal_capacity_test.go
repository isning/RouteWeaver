package render_test

import (
	"fmt"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// This case uses lengths produced by the actual invite/principal/frontend ID
// generators, not oversized arbitrary strings. Every principal is retained.
func TestManagedTerminalCapacityRejectsGeneratedMetadataBeforeRendering(t *testing.T) {
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	p.Listener.ID = "entry001"
	p.Principals = nil
	for i := 0; i < 1000; i++ {
		p.Principals = append(p.Principals, domain.ServerPrincipal{SubjectID: fmt.Sprintf("sub_%043d", i), AccountID: "u_" + strings.Repeat("a", 43), RouteID: "public-route_" + strings.Repeat("b", 16), CredentialVersion: "credential_" + strings.Repeat("c", 16), Credential: domain.PrincipalCredential{UUID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i)}, Action: domain.ActionRef{Kind: "direct"}, PolicyRevision: "topology_" + strings.Repeat("d", 16), CycleID: "cycle_" + strings.Repeat("e", 32)})
	}
	_, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "capacity", TopologyRevision: "topology_fixture", Programs: []domain.ServerProgram{p}})
	if err == nil || !strings.Contains(err.Error(), "MANAGED_TERMINAL_CAPACITY_EXCEEDED") {
		t.Fatalf("reachable oversized terminal proof must reject before activation, got %v", err)
	}
	if len(p.Principals) != 1000 {
		t.Fatal("capacity check truncated bindings")
	}
}

func TestManagedTerminalCapacityKeepsShortThousandPrincipalConfigurations(t *testing.T) {
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	p.Principals = nil
	for i := 0; i < 1000; i++ {
		p.Principals = append(p.Principals, domain.ServerPrincipal{SubjectID: fmt.Sprintf("s%04d", i), AccountID: "account", RouteID: "route", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i)}, Action: domain.ActionRef{Kind: "direct"}, PolicyRevision: "policy", CycleID: "cycle"})
	}
	if _, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "capacity", TopologyRevision: "revision", Programs: []domain.ServerProgram{p}}); err != nil {
		t.Fatal("count ceiling must not become arbitrary lower limit", err)
	}
}
