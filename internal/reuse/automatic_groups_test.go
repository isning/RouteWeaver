package reuse_test

import (
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/reuse"
	"strings"
	"testing"
)

func TestAutomaticTemplateGroupsCoverOnlyPresentRegionsAndSources(t *testing.T) {
	spec := reuse.Spec{Groups: []reuse.Group{{ID: "select", Name: "选择代理", Kind: "manual"}, {ID: "auto", Name: "自动选择", Kind: "url-test", IntervalSeconds: 60}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "select"}, AutomaticGroups: &reuse.AutomaticGroups{IncludeIn: []string{"select"}, RegionIncludeIn: []string{"auto"}}}
	endpoint := func(id, region, source string) domain.ClientEndpoint {
		return domain.ClientEndpoint{ID: id, Name: id, OwnerID: "owner", Region: region, Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.1", Port: 1080}, Provenance: []domain.SourceRef{{SourceID: source, SourceName: "Same display name"}}}
	}
	local := domain.ClientProfileIR{OwnerID: "owner", Endpoints: []domain.ClientEndpoint{endpoint("one", "JP", "source-a"), endpoint("two", "SG", "source-b"), endpoint("three", "", "source-a")}}
	got, err := spec.Instantiate(local, reuse.Bindings{})
	if err != nil {
		t.Fatal(err)
	}
	regions, sources := map[string]bool{}, 0
	for _, g := range got.Groups {
		if strings.HasPrefix(g.Name, "地区 · ") || g.Name == "其他地区" {
			regions[g.Name] = true
			if len(g.Members) == 0 {
				t.Fatal("empty group")
			}
		}
		if strings.HasPrefix(g.Name, "来源 · ") {
			sources++
		}
	}
	if len(regions) != 3 || !regions["地区 · JP"] || !regions["地区 · SG"] || !regions["其他地区"] || sources != 2 {
		t.Fatalf("wrong automatic groups: %+v", got.Groups)
	}
	if len(got.Groups[1].Members) != 3 {
		t.Fatal("automatic selection omits a region")
	}
	// Stable endpoint IDs, not list positions, define membership and generated identities.
	local.Endpoints[0], local.Endpoints[2] = local.Endpoints[2], local.Endpoints[0]
	reordered, err := spec.Instantiate(local, reuse.Bindings{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Groups, reordered.Groups) {
		t.Fatal("input order changed groups")
	}
	local.Endpoints = local.Endpoints[:1]
	reduced, err := spec.Instantiate(local, reuse.Bindings{})
	if err != nil {
		t.Fatal(err)
	}
	if len(reduced.Groups) != 4 {
		t.Fatal("stale or empty groups retained")
	}
}
func TestAutomaticTemplateGroupsRejectForeignConnectionsAndEmptyInputs(t *testing.T) {
	spec := reuse.Spec{AutomaticGroups: &reuse.AutomaticGroups{}}
	if _, err := spec.Instantiate(domain.ClientProfileIR{OwnerID: "owner"}, reuse.Bindings{}); err == nil {
		t.Fatal("empty selection accepted")
	}
	if _, err := spec.Instantiate(domain.ClientProfileIR{OwnerID: "owner", Endpoints: []domain.ClientEndpoint{{ID: "foreign", OwnerID: "other"}}}, reuse.Bindings{}); err == nil {
		t.Fatal("foreign connection accepted")
	}
}
