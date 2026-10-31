package httpapi

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

type NodeInput struct{ Body domain.Node }
type NodeUpdate struct {
	ID   string `path:"id"`
	Body domain.Node
}
type NodeOutput struct{ Body domain.Node }
type UserInput struct{ Body domain.User }
type UserUpdate struct {
	ID   string `path:"id"`
	Body domain.User
}
type UserOutput struct{ Body domain.User }
type RouteInput struct{ Body domain.Route }
type RouteUpdate struct {
	ID   string `path:"id"`
	Body domain.Route
}
type RouteOutput struct{ Body domain.Route }

func registerCRUD(api huma.API, s *store.Store, registry *render.Registry) {
	putNode := func(v domain.Node) (*NodeOutput, error) {
		if e := s.PutNode(v); e != nil {
			return nil, huma.Error400BadRequest(e.Error())
		}
		v.Status = "unregistered"
		return &NodeOutput{Body: v}, nil
	}
	putUser := func(v domain.User) (*UserOutput, error) {
		if e := s.PutUser(v); e != nil {
			return nil, huma.Error400BadRequest(e.Error())
		}
		st, _ := s.State()
		for _, u := range st.Users {
			if u.ID == v.ID {
				return &UserOutput{Body: u}, nil
			}
		}
		return nil, huma.Error500InternalServerError("saved user unavailable")
	}
	putRoute := func(v domain.Route) (*RouteOutput, error) {
		known := false
		for _, c := range registry.Capabilities() {
			known = known || c.ID == v.Engine
		}
		if !known {
			return nil, huma.Error400BadRequest("unknown renderer")
		}
		if e := s.PutRoute(v); e != nil {
			return nil, huma.Error400BadRequest(e.Error())
		}
		return &RouteOutput{Body: v}, nil
	}
	huma.Post(api, "/nodes", func(ctx context.Context, in *NodeInput) (*NodeOutput, error) { return putNode(in.Body) })
	huma.Put(api, "/nodes/{id}", func(ctx context.Context, in *NodeUpdate) (*NodeOutput, error) {
		if in.ID != in.Body.ID {
			return nil, huma.Error400BadRequest("id mismatch")
		}
		return putNode(in.Body)
	})
	huma.Post(api, "/users", func(ctx context.Context, in *UserInput) (*UserOutput, error) { return putUser(in.Body) })
	huma.Put(api, "/users/{id}", func(ctx context.Context, in *UserUpdate) (*UserOutput, error) {
		if in.ID != in.Body.ID {
			return nil, huma.Error400BadRequest("id mismatch")
		}
		return putUser(in.Body)
	})
	huma.Post(api, "/routes", func(ctx context.Context, in *RouteInput) (*RouteOutput, error) { return putRoute(in.Body) })
	huma.Put(api, "/routes/{id}", func(ctx context.Context, in *RouteUpdate) (*RouteOutput, error) {
		if in.ID != in.Body.ID {
			return nil, huma.Error400BadRequest("id mismatch")
		}
		return putRoute(in.Body)
	})
	for _, kind := range []string{"nodes", "users", "routes"} {
		huma.Delete(api, "/"+kind+"/{id}", func(ctx context.Context, in *IDInput) (*MessageOutput, error) {
			if e := s.Delete(kind, in.ID); e != nil {
				if e == store.ErrNotFound {
					return nil, huma.Error404NotFound("not found")
				}
				return nil, huma.Error409Conflict(e.Error())
			}
			out := &MessageOutput{}
			out.Body.OK = true
			return out, nil
		})
	}
	// The previous un-attributed quota mutation endpoint cannot safely represent
	// measured traffic. Preserve a clear migration error rather than dropping
	// over-quota traffic or inventing a route/rate attribution.
	huma.Post(api, "/users/{id}/usage", func(ctx context.Context, in *struct {
		ID   string `path:"id"`
		Body struct {
			BatchID string `json:"batchId"`
			Bytes   int64  `json:"bytes"`
		}
	}) (*MessageOutput, error) {
		return nil, huma.Error422UnprocessableEntity("unattributed usage is unsupported; submit a scoped meter batch to /api/usage")
	})
}
