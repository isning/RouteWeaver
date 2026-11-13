package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

type endpointImpactItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type endpointImpactTarget struct {
	Name         string `json:"name"`
	InstanceID   string `json:"instanceId"`
	InstanceName string `json:"instanceName"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Protocol     string `json:"protocol"`
}
type endpointImpact struct {
	Proposed      endpointImpactTarget `json:"proposed"`
	Endpoint      endpointImpactItem   `json:"endpoint"`
	ChangedFields []string             `json:"changedFields"`
	Deployments   []endpointImpactItem `json:"deployments"`
	Routes        []endpointImpactItem `json:"routes"`
	Links         []endpointImpactItem `json:"links"`
	ReviewToken   string               `json:"reviewToken"`
}
type endpointImpactProof struct {
	compares []store.RecordCompare
	sets     []store.RecordSetCompare
}

func (p *endpointImpactProof) read(s *store.Store, kind, id string, value any) error {
	var raw json.RawMessage
	if err := s.Get(kind, id, &raw); err != nil {
		return err
	}
	if err := strictSupported(raw, value); err != nil {
		return err
	}
	p.compares = append(p.compares, store.RecordCompare{Kind: kind, ID: id, Expected: raw})
	return nil
}
func (p *endpointImpactProof) list(s *store.Store, kind string, visit func(json.RawMessage) error) error {
	records, err := s.List(kind)
	if err != nil {
		return err
	}
	set := store.RecordSetCompare{Kind: kind, IDs: []string{}}
	for _, raw := range records {
		var identity struct {
			ID string `json:"id"`
		}
		if err = json.Unmarshal(raw, &identity); err != nil {
			return err
		}
		if !domain.ValidID(identity.ID) {
			return errors.New("cannot review inventory identity")
		}
		set.IDs = append(set.IDs, identity.ID)
		p.compares = append(p.compares, store.RecordCompare{Kind: kind, ID: identity.ID, Expected: raw})
		if err = visit(raw); err != nil {
			return err
		}
	}
	p.sets = append(p.sets, set)
	return nil
}

// The review captures the dependency sets as well as their values. Membership
// changes and secret-only edits invalidate consent at the same write transaction.
// Only labels/identities leave this function; copied connection values are not
// guessed to be identity references and no routing/application state is changed.
func (h *server) endpointImpactReview(v domain.ManagedEndpoint, revision string) (endpointImpact, endpointImpactProof, error) {
	view := endpointImpact{ChangedFields: []string{}, Deployments: []endpointImpactItem{}, Routes: []endpointImpactItem{}, Links: []endpointImpactItem{}}
	proof := endpointImpactProof{}
	var old domain.ManagedEndpoint
	if err := proof.read(h.s, "managed-endpoints", v.ID, &old); err != nil {
		return view, proof, err
	}
	if !sameReviewToken(revision, h.recordRevision("managed-endpoints", v.ID, proof.compares[0].Expected)) {
		return view, proof, store.ErrConflict
	}
	if v.Name == "" {
		return view, proof, errors.New("endpoint name required")
	}
	if err := domain.ValidateManagedEndpoint(v); err != nil {
		return view, proof, err
	}
	var instance domain.CoreInstance
	if err := proof.read(h.s, "core-instances", v.InstanceID, &instance); err != nil {
		return view, proof, err
	}
	if err := validateSingBoxOnlyEndpointTarget(v, instance); err != nil {
		return view, proof, err
	}
	view.Endpoint = endpointImpactItem{ID: old.ID, Name: old.Name}
	view.Proposed = endpointImpactTarget{Name: v.Name, InstanceID: instance.ID, InstanceName: instance.Name, Host: v.Connection.Host, Port: v.Connection.Port, Protocol: v.Connection.Protocol}
	if old.Name != v.Name {
		view.ChangedFields = append(view.ChangedFields, "名称")
	}
	if old.InstanceID != v.InstanceID {
		view.ChangedFields = append(view.ChangedFields, "核心实例")
	}
	if old.Authentication != v.Authentication {
		view.ChangedFields = append(view.ChangedFields, "认证模式")
	}
	if !reflect.DeepEqual(old.Connection, v.Connection) {
		view.ChangedFields = append(view.ChangedFields, "连接参数（含受保护字段）")
	}
	links := map[string]bool{}
	err := proof.list(h.s, "links", func(raw json.RawMessage) error {
		var link domain.Link
		if err := strictSupported(raw, &link); err != nil {
			return err
		}
		if link.From == v.ID || link.To == v.ID {
			links[link.ID] = true
			view.Links = append(view.Links, endpointImpactItem{ID: link.ID, Name: link.ID})
		}
		return nil
	})
	if err != nil {
		return view, proof, err
	}
	deployments := map[string]bool{}
	err = proof.list(h.s, "server-deployments", func(raw json.RawMessage) error {
		var deployment ServerDeployment
		if err := strictSupported(raw, &deployment); err != nil {
			return err
		}
		for _, program := range deployment.IR.Programs {
			if program.Listener.ID == v.ID {
				deployments[deployment.ID] = true
				view.Deployments = append(view.Deployments, endpointImpactItem{ID: deployment.ID, Name: deployment.Name})
				break
			}
		}
		return nil
	})
	if err != nil {
		return view, proof, err
	}
	err = proof.list(h.s, "published-routes", func(raw json.RawMessage) error {
		var route domain.PublishedRoute
		if err := strictSupported(raw, &route); err != nil {
			return err
		}
		affected := deployments[route.DeploymentID] || route.Path.Entry == v.ID || route.Path.Exit == v.ID
		for _, id := range route.EndpointIDs {
			affected = affected || id == v.ID
		}
		for _, id := range route.Path.Links {
			affected = affected || links[id]
		}
		if affected {
			view.Routes = append(view.Routes, endpointImpactItem{ID: route.ID, Name: route.Name})
		}
		return nil
	})
	if err != nil {
		return view, proof, err
	}
	view.ReviewToken, err = h.s.ReviewToken("managed-endpoint-impact/"+v.ID, struct {
		Draft   domain.ManagedEndpoint
		Records []store.RecordCompare
		Sets    []store.RecordSetCompare
	}{v, proof.compares, proof.sets})
	return view, proof, err
}
func (h *server) previewEndpointImpact(w http.ResponseWriter, r *http.Request) {
	var v domain.ManagedEndpoint
	if !decode(w, r, &v) {
		return
	}
	if !domain.ValidID(v.ID) || v.ID != chi.URLParam(r, "id") {
		fail(w, 400, "valid matching endpoint id required")
		return
	}
	view, _, err := h.endpointImpactReview(v, r.Header.Get("If-Match"))
	if errors.Is(err, store.ErrConflict) {
		fail(w, http.StatusConflict, "端点已更新，请重新打开端点后核对修改。当前输入仍保留。")
		return
	}
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, view)
}
func (h *server) saveReviewedEndpoint(r *http.Request, v domain.ManagedEndpoint) error {
	if r.Method == http.MethodPost {
		return h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "managed-endpoints", ID: v.ID}}, []store.RecordWrite{{Kind: "managed-endpoints", ID: v.ID, Value: v}})
	}
	view, proof, err := h.endpointImpactReview(v, r.Header.Get("If-Match"))
	if err != nil {
		return err
	}
	if !sameReviewToken(r.Header.Get("X-Endpoint-Impact"), view.ReviewToken) {
		return store.ErrConflict
	}
	return h.s.CompareSetsAndPutRecords(proof.compares, proof.sets, []store.RecordWrite{{Kind: "managed-endpoints", ID: v.ID, Value: v}})
}
