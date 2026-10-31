package domain_test

import (
	"routeweaver/internal/domain"
	"strings"
	"testing"
)

func profile() domain.ClientProfileIR {
	return domain.ClientProfileIR{SchemaVersion: "1.0", ID: "p", Name: "Daily", OwnerID: "u", Revision: "1", Endpoints: []domain.ClientEndpoint{{ID: "e", Name: "UK", OwnerID: "u", Origin: "imported", Connection: domain.Connection{Host: "example.org", Port: 1080, Protocol: "socks"}}}, Groups: []domain.PolicyGroup{{ID: "g1", Name: "Choose", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "e"}}}, {ID: "g2", Name: "Outer", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "g1"}}}, {ID: "g3", Name: "Deep", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "g2"}}}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "g3"}}
}
func TestProfileAcceptsDeepNestingAndRejectsCycle(t *testing.T) {
	p := profile()
	if err := domain.ValidateClientProfile(p); err != nil {
		t.Fatal(err)
	}
	p.Groups[0].Members = []domain.ActionRef{{Kind: "group", Ref: "g3"}}
	if err := domain.ValidateClientProfile(p); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("want cycle: %v", err)
	}
}
func TestProfileDoesNotExportTransitOrAnotherOwner(t *testing.T) {
	for _, mutate := range []func(*domain.ClientProfileIR){func(p *domain.ClientProfileIR) { p.Endpoints[0].Origin = "internal" }, func(p *domain.ClientProfileIR) { p.Endpoints[0].OwnerID = "other" }} {
		p := profile()
		mutate(&p)
		if err := domain.ValidateClientProfile(p); err == nil {
			t.Fatal("invalid ownership or transit accepted")
		}
	}
}
func TestTopologyAllowsThreeHopsSameHostAndDirect(t *testing.T) {
	g := domain.RouteGraph{Endpoints: []domain.ManagedEndpoint{{ID: "a", InstanceID: "same"}, {ID: "b", InstanceID: "same"}, {ID: "c", InstanceID: "third"}}, Links: []domain.Link{{ID: "ab", From: "a", To: "b"}, {ID: "bc", From: "b", To: "c"}}}
	path, err := domain.ResolvePath(g, domain.RoutePath{ID: "r", Entry: "a", Exit: "c", Links: []string{"ab", "bc"}})
	if err != nil || len(path) != 3 {
		t.Fatalf("%v %#v", err, path)
	}
	_, err = domain.ResolvePath(g, domain.RoutePath{ID: "direct", Entry: "b", Exit: "b"})
	if err != nil {
		t.Fatal(err)
	}
	g.Links = append(g.Links, domain.Link{ID: "ca", From: "c", To: "a"})
	if _, err = domain.ResolvePath(g, domain.RoutePath{ID: "direct", Entry: "b", Exit: "b"}); err != nil {
		t.Fatalf("unselected alternative inventory cycle rejected: %v", err)
	}
	if _, err = domain.ResolvePath(g, domain.RoutePath{ID: "loop", Entry: "a", Exit: "a", Links: []string{"ab", "bc", "ca"}}); err == nil {
		t.Fatal("selected path with repeated endpoint accepted")
	}
}
func TestStableNamesDoNotDependOnInputOrder(t *testing.T) {
	a := []domain.NamedIdentity{{ID: "a", Name: "Same"}, {ID: "b", Name: "Same"}}
	x, err := domain.StableNames(a)
	if err != nil {
		t.Fatal(err)
	}
	y, err := domain.StableNames([]domain.NamedIdentity{a[1], a[0]})
	if err != nil || x["a"] != y["a"] || x["b"] != y["b"] || x["a"] == x["b"] {
		t.Fatal("unstable or duplicate names")
	}
}

func TestProfileRejectsMissingReferencesAndPinnedRemoteResource(t *testing.T) {
	p := profile()
	p.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "missing"}}
	if err := domain.ValidateClientProfile(p); err == nil {
		t.Fatal("missing reference accepted")
	}
	p = profile()
	p.Resources = []domain.RuleResource{{ID: "rules", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "srs", FormatVersion: 5, Location: "remote", URL: "https://example.org/rules.srs", UpdatePolicy: "pinned", IntervalSeconds: 3600}}
	if err := domain.ValidateClientProfile(p); err == nil {
		t.Fatal("remote digest falsely presented as enforceable pin")
	}
}
func TestRenamingDoesNotChangeStableReferences(t *testing.T) {
	p := profile()
	before := p.Groups[0].Members[0]
	p.Endpoints[0].Name = "New friendly name"
	if err := domain.ValidateClientProfile(p); err != nil {
		t.Fatal(err)
	}
	if p.Groups[0].Members[0] != before {
		t.Fatal("renaming changed identity reference")
	}
}

func TestReadableNamesPersistAcrossCollisionChanges(t *testing.T) {
	initial, err := domain.AllocateNames([]domain.NamedIdentity{{ID: "z", Name: "UK [Work], London (TLS)"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if initial["z"].OutputName != "UK [Work], London (TLS)" {
		t.Fatal("unique label should remain readable")
	}
	expanded, err := domain.AllocateNames([]domain.NamedIdentity{{ID: "a", Name: "UK [Work], London (TLS)"}, {ID: "z", Name: "UK [Work], London (TLS)"}}, initial)
	if err != nil {
		t.Fatal(err)
	}
	if expanded["z"] != initial["z"] || expanded["a"].OutputName == expanded["z"].OutputName {
		t.Fatal("adding a collision renamed existing output")
	}
	removed, err := domain.AllocateNames([]domain.NamedIdentity{{ID: "a", Name: "UK [Work], London (TLS)"}}, expanded)
	if err != nil || removed["a"] != expanded["a"] {
		t.Fatal("removing a collision renamed surviving output")
	}
	renamed, err := domain.AllocateNames([]domain.NamedIdentity{{ID: "a", Name: "New York"}}, removed)
	if err != nil || renamed["a"].OutputName != "New York" {
		t.Fatal("explicit rename did not update name")
	}
}
