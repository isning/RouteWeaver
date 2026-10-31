package httpapi

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"time"
)

type SubscriptionEntry struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	RouteID   string            `json:"routeId"`
	Engine    string            `json:"engine"`
	Artifacts []domain.Artifact `json:"artifacts"`
}
type SubscriptionOutput struct {
	Body struct {
		UserID        string              `json:"userId"`
		Entries       []SubscriptionEntry `json:"entries"`
		Warnings      []string            `json:"warnings"`
		NativeChecked bool                `json:"nativeChecked"`
	}
}

func registerSubscriptions(api huma.API, s *store.Store, registry *render.Registry, h *server) {
	huma.Get(api, "/subscriptions/{id}", func(ctx context.Context, in *IDInput) (*SubscriptionOutput, error) {
		st, e := s.State()
		if e != nil {
			return nil, huma.Error500InternalServerError("cannot read state")
		}
		var user *domain.User
		for i := range st.Users {
			if st.Users[i].ID == in.ID {
				user = &st.Users[i]
			}
		}
		if user == nil {
			return nil, huma.Error404NotFound("user not found")
		}
		overview, e := h.overview(user.ID, time.Now())
		if e != nil {
			return nil, huma.Error500InternalServerError("cannot resolve effective entitlement")
		}
		if overview.Status != "active" {
			return nil, huma.Error403Forbidden("user disabled or quota exhausted")
		}
		out := &SubscriptionOutput{}
		out.Body.UserID = user.ID
		out.Body.Entries = []SubscriptionEntry{}
		out.Body.Warnings = []string{"Admin-only preview. Artifacts have not been validated by native cores."}
		names := map[string]int{}
		for _, r := range st.Routes {
			assigned := false
			for _, allowed := range overview.Routes {
				assigned = assigned || allowed.ID == r.ID
			}
			if !assigned {
				continue
			}
			name, e := domain.SubscriptionName(r, st.Nodes)
			if e != nil {
				return nil, huma.Error422UnprocessableEntity(e.Error())
			}
			a, e := registry.Render(r, st.Nodes)
			if e != nil {
				return nil, huma.Error422UnprocessableEntity(e.Error())
			}
			names[name]++
			out.Body.Entries = append(out.Body.Entries, SubscriptionEntry{ID: r.ID, Name: name, RouteID: r.ID, Engine: r.Engine, Artifacts: a})
		}
		for i := range out.Body.Entries {
			v := &out.Body.Entries[i]
			if names[v.Name] > 1 {
				v.Name += " [" + v.ID + "]"
			}
		}
		return out, nil
	})
}
