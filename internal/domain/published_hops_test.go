package domain_test

import (
	"fmt"
	"reflect"
	"testing"

	"routeweaver/internal/domain"
)

func managedHop(id string) domain.PublishedRouteHop {
	return domain.PublishedRouteHop{Kind: "managed", EndpointID: id}
}
func connectorHop(id string) domain.PublishedRouteHop {
	return domain.PublishedRouteHop{Kind: "connector", ConnectorID: id}
}
func hopRoute(hops ...domain.PublishedRouteHop) domain.PublishedRoute {
	r := domain.PublishedRoute{Hops: hops}
	for _, hop := range hops {
		if hop.Kind == "managed" {
			r.EndpointIDs = append(r.EndpointIDs, hop.EndpointID)
		}
	}
	if len(r.EndpointIDs) > 0 {
		r.Path.Entry = r.EndpointIDs[0]
		r.Path.Exit = r.EndpointIDs[len(r.EndpointIDs)-1]
	}
	return r
}

func TestResolvePublishedRouteHopsPreservesOrderAndScopes(t *testing.T) {
	want := []domain.PublishedRouteHop{managedHop("a"), connectorHop("x"), connectorHop("y"), managedHop("b"), connectorHop("x")}
	route := hopRoute(want...)
	got, err := domain.ResolvePublishedRouteHops(route)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, %v", got, err)
	}
	got[0].EndpointID = "changed"
	if route.Hops[0].EndpointID != "a" {
		t.Fatal("resolved path aliases stored intent")
	}
	if !domain.HasExternalHops(route) {
		t.Fatal("external hops absent")
	}
}

func TestResolvePublishedRouteHopsNormalizesLegacy(t *testing.T) {
	route := hopRoute(managedHop("a"), managedHop("b"))
	want := append([]domain.PublishedRouteHop(nil), route.Hops...)
	route.Hops = nil
	got, err := domain.ResolvePublishedRouteHops(route)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, %v", got, err)
	}
	if domain.HasExternalHops(route) {
		t.Fatal("legacy path contains external hops")
	}
	// Empty optional hops have the same compatibility meaning as an omitted field.
	route.Hops = []domain.PublishedRouteHop{}
	if _, err := domain.ResolvePublishedRouteHops(route); err != nil {
		t.Fatal(err)
	}
}

func TestResolvePublishedRouteHopsRejectsInvalidIntent(t *testing.T) {
	tests := map[string]func(*domain.PublishedRoute){
		"empty": func(r *domain.PublishedRoute) {
			*r = domain.PublishedRoute{}
		},
		"connector first": func(r *domain.PublishedRoute) {
			r.Hops = append([]domain.PublishedRouteHop{connectorHop("x")}, r.Hops...)
		},
		"unknown kind": func(r *domain.PublishedRoute) {
			r.Hops[1].Kind = "source"
		},
		"managed extra field": func(r *domain.PublishedRoute) {
			r.Hops[0].ConnectorID = "x"
		},
		"connector extra field": func(r *domain.PublishedRoute) {
			r.Hops[1].EndpointID = "a"
		},
		"missing connector identity": func(r *domain.PublishedRoute) {
			r.Hops[1].ConnectorID = ""
		},
		"invalid connector identity": func(r *domain.PublishedRoute) {
			r.Hops[1].ConnectorID = "bad/id"
		},
		"invalid managed identity": func(r *domain.PublishedRoute) {
			r.Hops[0].EndpointID = "bad/id"
			r.EndpointIDs[0] = "bad/id"
			r.Path.Entry = "bad/id"
		},
		"duplicate managed": func(r *domain.PublishedRoute) {
			*r = hopRoute(managedHop("a"), managedHop("a"))
		},
		"duplicate scoped connector": func(r *domain.PublishedRoute) {
			*r = hopRoute(managedHop("a"), connectorHop("x"), connectorHop("x"))
		},
		"missing projection": func(r *domain.PublishedRoute) {
			r.EndpointIDs = nil
		},
		"different projection": func(r *domain.PublishedRoute) {
			r.EndpointIDs[1] = "c"
		},
		"extra projection": func(r *domain.PublishedRoute) {
			r.EndpointIDs = append(r.EndpointIDs, "c")
		},
		"entry mismatch": func(r *domain.PublishedRoute) {
			r.Path.Entry = "b"
		},
		"exit mismatch": func(r *domain.PublishedRoute) {
			r.Path.Exit = "x"
		},
		"invalid legacy": func(r *domain.PublishedRoute) {
			r.Hops = nil
			r.EndpointIDs = []string{"a", "a"}
			r.Path.Exit = "a"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			route := hopRoute(managedHop("a"), connectorHop("x"), managedHop("b"))
			mutate(&route)
			if got, err := domain.ResolvePublishedRouteHops(route); err == nil || got != nil {
				t.Fatalf("expected refusal without partial path, got %#v, %v", got, err)
			}
		})
	}
}

func TestResolvePublishedRouteHopsBounds(t *testing.T) {
	for _, count := range []int{32, 33} {
		hops := []domain.PublishedRouteHop{}
		for i := 0; i < count; i++ {
			hops = append(hops, managedHop(fmt.Sprintf("m%d", i)))
		}
		_, err := domain.ResolvePublishedRouteHops(hopRoute(hops...))
		if (err == nil) != (count == 32) {
			t.Fatalf("managed count %d: %v", count, err)
		}
	}
	for _, count := range []int{64, 65} {
		hops := []domain.PublishedRouteHop{managedHop("a")}
		for i := 1; i < count; i++ {
			hops = append(hops, connectorHop(fmt.Sprintf("c%d", i)))
		}
		_, err := domain.ResolvePublishedRouteHops(hopRoute(hops...))
		if (err == nil) != (count == 64) {
			t.Fatalf("total count %d: %v", count, err)
		}
	}
}
