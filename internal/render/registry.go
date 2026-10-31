// Package render compiles intent into client configuration artifacts. Rendering is
// NOT native-core validation, deployment, or evidence of working connectivity.
package render

import (
	"fmt"
	"routeweaver/internal/domain"
	"sort"
)

type Renderer interface {
	Capability() domain.Capability
	Render(domain.Route, []domain.Node) ([]domain.Artifact, error)
}
type Registry struct{ renderers map[string]Renderer }

func New(rs ...Renderer) *Registry {
	r := &Registry{renderers: map[string]Renderer{}}
	for _, v := range rs {
		if err := r.Register(v); err != nil {
			panic(err)
		}
	}
	return r
}
func (r *Registry) Register(v Renderer) error {
	c := v.Capability()
	if !validAdapterID(c.ID) {
		return fmt.Errorf("invalid renderer id")
	}
	if _, exists := r.renderers[c.ID]; exists {
		return fmt.Errorf("duplicate renderer %s", c.ID)
	}
	r.renderers[c.ID] = v
	return nil
}
func (r *Registry) Capabilities() []domain.Capability {
	out := []domain.Capability{}
	for _, v := range r.renderers {
		out = append(out, v.Capability())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func (r *Registry) Render(route domain.Route, nodes []domain.Node) ([]domain.Artifact, error) {
	if e := domain.ValidateRoute(route, nodes); e != nil {
		return nil, e
	}
	v, ok := r.renderers[route.Engine]
	if !ok {
		return nil, fmt.Errorf("unknown renderer %q", route.Engine)
	}
	c := v.Capability()
	if c.MaxHops > 0 && len(route.Hops) > c.MaxHops {
		return nil, fmt.Errorf("renderer hop limit exceeded")
	}
	selected := []domain.Node{}
	for _, id := range route.Hops {
		for _, n := range nodes {
			if n.ID == id {
				supported := false
				for _, p := range c.Protocols {
					supported = supported || p == n.Protocol
				}
				if !supported {
					return nil, fmt.Errorf("unsupported protocol %s", n.Protocol)
				}
				selected = append(selected, n)
			}
		}
	}
	return v.Render(route, selected)
}
func Default() *Registry { return New(Xray{}, SingBox{}) }
