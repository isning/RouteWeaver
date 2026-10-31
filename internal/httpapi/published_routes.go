package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

// The API accepts the selected endpoint sequence, never a client chain. Links
// are generated from stable pairs only after inventory and native forwarding
// intent have both been checked.
type publishedRouteInput struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	DeploymentID string   `json:"deploymentId"`
	EndpointIDs  []string `json:"endpointIds"`
	PublicHost   string   `json:"publicHost"`
	PublicPort   int      `json:"publicPort"`
}

func (h *server) registerPublishedRouteAdmin(r chi.Router) {
	r.Get("/published-routes", func(w http.ResponseWriter, r *http.Request) {
		records, e := h.s.List("published-routes")
		if e != nil {
			storeError(w, e)
			return
		}
		out := []any{}
		for _, raw := range records {
			var route domain.PublishedRoute
			if e = json.Unmarshal(raw, &route); e != nil {
				storeError(w, e)
				return
			}
			out = append(out, h.publishedRouteSummary(route, raw))
		}
		writeJSON(w, 200, out)
	})
	save := func(preview bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var in publishedRouteInput
			if !decode(w, r, &in) {
				return
			}
			if e := ensureID(&in.ID); e != nil {
				storeError(w, e)
				return
			}
			if !pathMatches(r, in.ID) {
				fail(w, 400, "id mismatch")
				return
			}
			proof := &preparedFleet{}
			var expected *store.RecordCompare
			if !preview {
				var err error
				expected, err = h.expectedRecord(r, "published-routes", in.ID)
				if err != nil {
					storeError(w, err)
					return
				}
				proof.Compares = append(proof.Compares, *expected)
			}
			route, links, e := h.preparePublishedRouteWithProof(in, proof)
			if e != nil {
				fail(w, 422, e.Error())
				return
			}
			if !preview {
				// No legacy chain can share a service identity with a managed published path.
				var legacy domain.Route
				if e = h.fleetRead(proof, "routes", route.ID, &legacy, true); e == nil && legacy.ID != "" {
					fail(w, 409, "identity already belongs to a legacy route")
					return
				} else if e != nil {
					storeError(w, e)
					return
				}
				writes := []store.RecordWrite{{Kind: "published-routes", ID: route.ID, Value: route}}
				for _, link := range links {
					writes = append(writes, store.RecordWrite{Kind: "links", ID: link.ID, Value: link})
				}
				if e = h.s.CompareSetsAndPutRecords(proof.Compares, proof.Sets, writes); e != nil {
					storeError(w, e)
					return
				}
				h.s.Audit(current(r).Account.ID, "published-route.saved", route.ID)
			}
			out := h.publishedRouteSummary(route)
			out["preview"] = preview
			writeJSON(w, 200, out)
		}
	}
	r.Post("/published-routes/preview", save(true))
	r.Post("/published-routes", save(false))
	r.Put("/published-routes/{id}", save(false))
	r.Get("/published-routes/{id}/resolve", func(w http.ResponseWriter, r *http.Request) {
		var raw json.RawMessage
		if e := h.s.Get("published-routes", chi.URLParam(r, "id"), &raw); e != nil {
			storeError(w, e)
			return
		}
		var v domain.PublishedRoute
		if e := json.Unmarshal(raw, &v); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, h.publishedRouteSummary(v, raw))
	})
	r.Post("/published-routes/{id}/principals", h.savePublishedPrincipal)
	h.registerRouteRetarget(r)
}

func (h *server) preparePublishedRoute(in publishedRouteInput) (domain.PublishedRoute, []domain.Link, error) {
	return h.preparePublishedRouteWithProof(in, &preparedFleet{})
}
func (h *server) preparePublishedRouteWithProof(in publishedRouteInput, proof *preparedFleet) (domain.PublishedRoute, []domain.Link, error) {
	route := domain.PublishedRoute{ID: in.ID, Name: in.Name, DeploymentID: in.DeploymentID, EndpointIDs: in.EndpointIDs, PublicHost: in.PublicHost, PublicPort: in.PublicPort}
	if !domain.ValidID(in.ID) || strings.TrimSpace(in.Name) == "" || !domain.ValidID(in.DeploymentID) || len(in.EndpointIDs) == 0 || len(in.EndpointIDs) > 32 {
		return route, nil, fmt.Errorf("stable route identity, name, deployment and selected endpoint path required")
	}
	// Validate the public network address without accepting any user/transit secret.
	if err := domain.ValidateConnection(domain.Connection{Protocol: "socks", Host: in.PublicHost, Port: in.PublicPort}); err != nil {
		return route, nil, err
	}
	var deployment ServerDeployment
	if err := h.fleetRead(proof, "server-deployments", in.DeploymentID, &deployment, false); err != nil {
		return route, nil, err
	}
	graph := domain.RouteGraph{}
	links := []domain.Link{}
	for i, id := range in.EndpointIDs {
		var endpoint domain.ManagedEndpoint
		if err := h.fleetRead(proof, "managed-endpoints", id, &endpoint, false); err != nil {
			return route, nil, fmt.Errorf("selected endpoint missing: %s", id)
		}
		var instance domain.CoreInstance
		if err := h.fleetRead(proof, "core-instances", endpoint.InstanceID, &instance, false); err != nil {
			return route, nil, err
		}
		var host domain.Host
		if err := h.fleetRead(proof, "hosts", instance.HostID, &host, false); err != nil {
			return route, nil, err
		}
		graph.Endpoints = append(graph.Endpoints, endpoint)
		if i > 0 {
			sum := sha256.Sum256([]byte(in.EndpointIDs[i-1] + "\x00" + id))
			links = append(links, domain.Link{ID: "path_" + hex.EncodeToString(sum[:16]), From: in.EndpointIDs[i-1], To: id})
		}
	}
	route.Path = domain.RoutePath{ID: route.ID, Entry: in.EndpointIDs[0], Exit: in.EndpointIDs[len(in.EndpointIDs)-1], Links: []string{}}
	for _, link := range links {
		route.Path.Links = append(route.Path.Links, link.ID)
	}
	for _, link := range links {
		var existing domain.Link
		if err := h.fleetRead(proof, "links", link.ID, &existing, true); err != nil {
			return route, nil, err
		}
		if existing.ID != "" && existing != link {
			return route, nil, store.ErrConflict
		}
	}
	graph.Links = links
	endpoints, err := domain.ResolvePath(graph, route.Path)
	if err != nil {
		return route, nil, err
	}
	if err = domain.ValidatePublishedEntrySecurity(route, endpoints[0].Connection); err != nil {
		return route, nil, err
	}

	if _, err = h.publishedPathActionWithProof(deployment.IR, route, endpoints, proof); err != nil {
		return route, nil, err
	}
	return route, links, nil
}

// publishedPathAction proves the selected simple path against the actual server
// default forwarding. Per-user branching is at the public ingress; transit
// must have one explicit, unambiguous next hop. Arbitrary policy graphs cannot
// silently masquerade as the selected linear route.
func (h *server) publishedPathAction(ir domain.ServerDeploymentIR, route domain.PublishedRoute, endpoints []domain.ManagedEndpoint) (domain.ActionRef, error) {
	return h.publishedPathActionWithProof(ir, route, endpoints, &preparedFleet{})
}

// publishedPathRefusal marks only a completed pure path proof's refusal.
// Dependency read failures retain their original operational error identity.
type publishedPathRefusal struct{ cause error }

func (e *publishedPathRefusal) Error() string { return e.cause.Error() }
func (e *publishedPathRefusal) Unwrap() error { return e.cause }

func (h *server) publishedPathActionWithProof(ir domain.ServerDeploymentIR, route domain.PublishedRoute, endpoints []domain.ManagedEndpoint, proof *preparedFleet) (domain.ActionRef, error) {
	dialConnections := make([]domain.Connection, len(endpoints))
	for i, endpoint := range endpoints {
		dialConnections[i] = endpoint.Connection
		if i == 0 || endpoint.Connection.Host != "0.0.0.0" && endpoint.Connection.Host != "::" {
			continue
		}
		// A wildcard is a listener bind, never a dial destination. Only the
		// endpoint's registered host may replace it, as in the UI path compiler.
		var instance domain.CoreInstance
		if err := h.fleetRead(proof, "core-instances", endpoint.InstanceID, &instance, false); err != nil {
			return domain.ActionRef{}, err
		}
		var host domain.Host
		if err := h.fleetRead(proof, "hosts", instance.HostID, &host, false); err != nil {
			return domain.ActionRef{}, err
		}
		dialConnections[i].Host = host.Address
	}
	action, err := verifyPublishedPath(ir, route, endpoints, dialConnections)
	if err != nil {
		return action, &publishedPathRefusal{cause: err}
	}
	return action, nil
}
func verifyPublishedPath(ir domain.ServerDeploymentIR, route domain.PublishedRoute, endpoints []domain.ManagedEndpoint, dialConnections []domain.Connection) (domain.ActionRef, error) {
	action := domain.ActionRef{Kind: "direct"}
	for i, endpoint := range endpoints {
		var program *domain.ServerProgram
		for j := range ir.Programs {
			if ir.Programs[j].Listener.ID == endpoint.ID {
				program = &ir.Programs[j]
				break
			}
		}
		if program == nil || program.Listener.InstanceID != endpoint.InstanceID {
			return action, fmt.Errorf("selected endpoint has no deployment program")
		}
		if !sameListenerNetwork(program.Listener.Connection, endpoint.Connection) {
			return action, fmt.Errorf("deployment listener differs from registered endpoint")
		}
		if i > 0 && len(program.Principals) > 0 {
			return action, fmt.Errorf("transit endpoints with per-user branches require an explicit transit binding")
		}
		if len(program.Rules) > 0 {
			return action, fmt.Errorf("selected path has conditional forwarding; use an explicit unambiguous path")
		}
		nextAction := program.DefaultAction
		connectors := program.Connectors
		if len(program.Egress) > 0 {
			if len(connectors) > 0 || len(program.Egress) != 1 {
				return action, fmt.Errorf("selected path requires a single next-hop connector per program")
			}
			connectors = []domain.ServerConnector{{ID: "egress-1", Connection: program.Egress[0]}}
			nextAction = domain.ActionRef{Kind: "forward", Ref: "egress-1"}
		} else if nextAction.Kind == "" {
			nextAction = domain.ActionRef{Kind: "direct"}
		}
		// Managed public ingress selects a path by authenticated principal, not
		// by one global default. Transit remains fixed and unambiguous.
		if i == 0 && program.Instance.AdapterID == render.ServerAdapterManagedXray {
			if len(endpoints) == 1 {
				nextAction = domain.ActionRef{Kind: "direct"}
			} else {
				matches := 0
				for _, connector := range connectors {
					if connector.Via == "" && reflect.DeepEqual(connector.Connection, dialConnections[i+1]) {
						matches++
						nextAction = domain.ActionRef{Kind: "forward", Ref: connector.ID}
					}
				}
				if matches != 1 {
					return action, fmt.Errorf("selected public path requires exactly one matching next-hop connector")
				}
			}
		}
		if i == len(endpoints)-1 {
			if nextAction.Kind != "direct" || nextAction.Ref != "" {
				return action, fmt.Errorf("selected exit must terminate at direct egress")
			}
		} else {
			if nextAction.Kind != "forward" {
				return action, fmt.Errorf("selected hop does not forward to next endpoint")
			}
			found := false
			for _, connector := range connectors {
				if connector.ID == nextAction.Ref && connector.Via == "" && reflect.DeepEqual(connector.Connection, dialConnections[i+1]) {
					found = true
				}
			}
			if !found {
				return action, fmt.Errorf("selected next hop does not match deployed connector or has hidden detour")
			}
		}
		if i == 0 {
			action = nextAction
		}
	}
	return action, nil
}
func sameListenerNetwork(a, b domain.Connection) bool {
	a.UUID = ""
	a.Flow = ""
	a.Username = ""
	a.Password = ""
	a.Method = ""
	b.UUID = ""
	b.Flow = ""
	b.Username = ""
	b.Password = ""
	b.Method = ""
	return reflect.DeepEqual(a, b)
}

// Only names and stable identities cross this read-model boundary. Programs
// contain credentials and server-only material and must never be serialized.
type publishedPathHopSummary struct {
	EndpointID    string `json:"endpointId"`
	Name          string `json:"name,omitempty"`
	MetadataState string `json:"metadataState"`
}
type publishedPathSummary struct {
	Hops []publishedPathHopSummary `json:"hops"`
}

func summarizePublishedPath(ids []string, programs []domain.ServerProgram) publishedPathSummary {
	summary := publishedPathSummary{Hops: make([]publishedPathHopSummary, 0, len(ids))}
	for _, id := range ids {
		hop := publishedPathHopSummary{EndpointID: id, MetadataState: "unavailable"}
		matches := 0
		for _, program := range programs {
			if program.Listener.ID == id {
				matches++
				hop.Name = program.Listener.Name
			}
		}
		if matches == 1 {
			hop.MetadataState = "snapshot"
		} else {
			hop.Name = ""
		}
		summary.Hops = append(summary.Hops, hop)
	}
	return summary
}

func (h *server) publishedRouteSummary(route domain.PublishedRoute, stored ...json.RawMessage) map[string]any {
	var revisionValue any = route
	if len(stored) == 1 {
		revisionValue = stored[0]
	}
	status := "draft"
	diagnostics := []string{}
	fingerprint := ""
	pendingChanges := false
	var effective any
	var deployment ServerDeployment
	if e := h.s.Get("server-deployments", route.DeploymentID, &deployment); e == nil {
		fingerprint = serverFingerprint(deployment.IR)
		for _, program := range deployment.IR.Programs {
			if program.Listener.ID == route.Path.Entry {
				var desired controlprotocol.Desired
				if h.s.Get("agent-desired", program.Instance.ID, &desired) == nil {
					var queued domain.PublishedManifest
					if h.s.Get("published-manifests", desired.RevisionID, &queued) == nil && queued.DeploymentID == route.DeploymentID {
						for _, snapshot := range queued.Routes {
							if snapshot.ID == route.ID {
								status = "queued"
							}
						}
					}
				}
				if bundle, e := h.appliedPublishedPathBundle(route.ID); e == nil {
					applied := bundle.Entry
					for _, snapshot := range applied.Routes {
						if snapshot.ID != route.ID {
							continue
						}
						status = "effective"
						effective = map[string]any{"publicHost": snapshot.PublicHost, "publicPort": snapshot.PublicPort, "endpointIds": snapshot.EndpointIDs, "fingerprint": applied.Fingerprint, "path": summarizePublishedPath(snapshot.EndpointIDs, bundle.Programs)}
						pendingChanges = fingerprint != applied.Fingerprint || route.DeploymentID != snapshot.DeploymentID || route.PublicHost != snapshot.PublicHost || route.PublicPort != snapshot.PublicPort || !reflect.DeepEqual(route.EndpointIDs, snapshot.EndpointIDs)
					}
				}
			}
		}
	} else {
		diagnostics = append(diagnostics, "Deployment is missing")
	}
	return map[string]any{"revisionToken": h.recordRevision("published-routes", route.ID, revisionValue), "id": route.ID, "name": route.Name, "deploymentId": route.DeploymentID, "path": route.Path, "endpointIds": route.EndpointIDs, "savedPath": summarizePublishedPath(route.EndpointIDs, deployment.IR.Programs), "publicHost": route.PublicHost, "publicPort": route.PublicPort, "status": status, "diagnostics": diagnostics, "fingerprint": fingerprint, "pendingChanges": pendingChanges, "effective": effective}
}
