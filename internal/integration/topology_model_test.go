package integration_test

import (
	"fmt"
	"testing"

	"routeweaver/internal/domain"
)

// Exhaustive bounded check: all 64 directed inventories on three endpoints,
// every vertex walk of up to three edges, and correct/incorrect explicit exits.
// The specification is a simple selected path; unused reverse links may exist.
// This finite check is not a proof for arbitrary graph sizes or native routing.
func TestBoundedSelectedPathModel(t *testing.T) {
	vertices := []string{"a", "b", "c"}
	edgeBit := map[string]uint{}
	bit := uint(0)
	for _, from := range vertices {
		for _, to := range vertices {
			if from != to {
				edgeBit[from+"_"+to] = bit
				bit++
			}
		}
	}
	cases := 0
	for mask := 0; mask < 64; mask++ {
		graph := domain.RouteGraph{}
		for _, id := range vertices {
			graph.Endpoints = append(graph.Endpoints, domain.ManagedEndpoint{ID: id, InstanceID: "shared-instance"})
		}
		for _, from := range vertices {
			for _, to := range vertices {
				key := from + "_" + to
				if position, exists := edgeBit[key]; exists && mask&(1<<position) != 0 {
					graph.Links = append(graph.Links, domain.Link{ID: key, From: from, To: to})
				}
			}
		}
		var walk func([]string)
		walk = func(path []string) {
			links := []string{}
			members := map[string]bool{}
			valid := true
			for i, id := range path {
				if members[id] {
					valid = false
				}
				members[id] = true
				if i > 0 {
					key := path[i-1] + "_" + id
					links = append(links, key)
					position, exists := edgeBit[key]
					if !exists || mask&(1<<position) == 0 {
						valid = false
					}
				}
			}
			for _, exit := range vertices {
				selected := domain.RoutePath{ID: "route", Entry: path[0], Exit: exit, Links: links}
				resolved, err := domain.ResolvePath(graph, selected)
				want := valid && exit == path[len(path)-1]
				cases++
				if (err == nil) != want {
					t.Fatalf("inventory=%06b walk=%v exit=%s expectedValid=%v: %v", mask, path, exit, want, err)
				}
				if want {
					if len(resolved) != len(path) {
						t.Fatal("resolved path length changed")
					}
					for i, e := range resolved {
						if e.ID != path[i] {
							t.Fatal("resolved path identity changed")
						}
					}
				}
			}
			if len(path) < 4 {
				for _, next := range vertices {
					copyPath := append(append([]string{}, path...), next)
					walk(copyPath)
				}
			}
		}
		for _, start := range vertices {
			walk([]string{start})
		}
	}
	t.Log(fmt.Sprintf("checked %d selected-path cases across all 64 three-endpoint inventories", cases))
}
