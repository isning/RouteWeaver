package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/danielgtaylor/huma/v2"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"time"
)

type RenderBody struct {
	Valid         bool              `json:"valid"`
	NativeChecked bool              `json:"nativeChecked"`
	Diagnostics   []string          `json:"diagnostics"`
	Artifacts     []domain.Artifact `json:"artifacts"`
	Revision      *domain.Revision  `json:"revision,omitempty"`
}
type RenderOutput struct{ Body RenderBody }

func registerRender(api huma.API, s *store.Store, registry *render.Registry) {
	huma.Post(api, "/routes/{id}/validate", func(ctx context.Context, in *IDInput) (*RenderOutput, error) {
		st, e := s.State()
		if e != nil {
			return nil, huma.Error500InternalServerError("cannot read state")
		}
		var route *domain.Route
		for i := range st.Routes {
			if st.Routes[i].ID == in.ID {
				route = &st.Routes[i]
			}
		}
		if route == nil {
			return nil, huma.Error404NotFound("route not found")
		}
		a, e := registry.Render(*route, st.Nodes)
		if e != nil {
			return &RenderOutput{Body: RenderBody{Diagnostics: []string{e.Error()}, Artifacts: []domain.Artifact{}}}, nil
		}
		b, _ := json.Marshal(a)
		digest := sha256.Sum256(b)
		id := make([]byte, 16)
		if _, e = rand.Read(id); e != nil {
			return nil, huma.Error500InternalServerError("cannot create revision id")
		}
		rev := domain.Revision{ID: hex.EncodeToString(id), RouteID: route.ID, Engine: route.Engine, Status: "rendered", CreatedAt: time.Now().UTC(), Artifacts: a, Digest: hex.EncodeToString(digest[:])}
		if e = s.RecordRevision(rev); e != nil {
			return nil, huma.Error500InternalServerError("cannot save revision")
		}
		return &RenderOutput{Body: RenderBody{Valid: true, Diagnostics: []string{"Structural checks passed. Native core validation, deployment and connectivity have not been performed."}, Artifacts: a, Revision: &rev}}, nil
	})
}
