package httpapi_test

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

const mixedSecret = "mixed-connector-secret-canary"

func mixedHops(ids ...string) []domain.PublishedRouteHop {
	hops := []domain.PublishedRouteHop{}
	for _, id := range ids {
		if id == "fra" || id == "uk" {
			hops = append(hops, domain.PublishedRouteHop{Kind: "managed", EndpointID: id})
		} else {
			hops = append(hops, domain.PublishedRouteHop{Kind: "connector", ConnectorID: id})
		}
	}
	return hops
}

func mixedInput(ids ...string) map[string]any {
	return map[string]any{"id": "mixed-route", "name": "Mixed route", "deploymentId": "deployment", "hops": mixedHops(ids...), "publicHost": "10.0.0.1", "publicPort": 1080}
}

func seedMixedPath(t *testing.T, ids ...string) (*store.Store, *httptest.Server, httpapi.ServerDeployment) {
	t.Helper()
	s, srv, deployment, old, _ := newRetargetFixture(t)
	for i := range deployment.IR.Programs {
		deployment.IR.Programs[i].Egress = nil
		deployment.IR.Programs[i].Connectors = nil
		deployment.IR.Programs[i].DefaultAction = domain.ActionRef{Kind: "direct"}
	}
	program, previous := 0, ""
	for _, id := range ids[1:] {
		p := &deployment.IR.Programs[program]
		if id == "uk" {
			p.Connectors = append(p.Connectors, domain.ServerConnector{ID: "to-uk", Via: previous, Connection: old.Connection})
			p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "to-uk"}
			program, previous = 1, ""
		} else {
			p.Connectors = append(p.Connectors, domain.ServerConnector{ID: id, Via: previous, Connection: domain.Connection{Protocol: "socks", Host: id + ".example.invalid", Port: 1080, Username: "proxy-user", Password: mixedSecret}})
			p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: id}
			previous = id
		}
	}
	deployment.IR.Programs[0].Principals[0].Action = deployment.IR.Programs[0].DefaultAction
	if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
		t.Fatal(err)
	}
	return s, srv, deployment
}

func assertMixedPublicSummary(t *testing.T, summary map[string]any, raw string, want []domain.PublishedRouteHop) {
	t.Helper()
	if strings.Contains(raw, mixedSecret) || strings.Contains(raw, "proxy-user") || strings.Contains(raw, ".example.invalid") {
		t.Fatalf("connector details leaked: %s", raw)
	}
	data, err := json.Marshal(summary["hops"])
	if err != nil {
		t.Fatal(err)
	}
	var got []domain.PublishedRouteHop
	if err := json.Unmarshal(data, &got); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("path lost order: %s %v", data, err)
	}
	saved, ok := summary["savedPath"].(map[string]any)
	if !ok {
		t.Fatalf("missing complete saved path: %s", raw)
	}
	if hops, ok := saved["hops"].([]any); !ok || len(hops) != len(want) {
		t.Fatalf("summary flattened path: %s", raw)
	}
}

func TestPublishedMixedPathsPublicPreviewSaveResolve(t *testing.T) {
	for _, ids := range [][]string{{"fra", "x"}, {"fra", "x", "y"}, {"fra", "x", "uk"}, {"fra", "uk", "y"}, {"fra", "x", "uk", "y"}} {
		t.Run(strings.Join(ids, "-"), func(t *testing.T) {
			s, srv, _ := seedMixedPath(t, ids...)
			input := mixedInput(ids...)
			for _, path := range []string{"/api/published-routes/preview", "/api/published-routes"} {
				code, result, raw := req(t, operatorClient(), "POST", srv.URL+path, "", input)
				if code != 200 {
					t.Fatalf("%s: %d %s", path, code, raw)
				}
				assertMixedPublicSummary(t, result, raw, mixedHops(ids...))
			}
			code, result, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
			if code != 200 {
				t.Fatalf("resolve: %d %s", code, raw)
			}
			assertMixedPublicSummary(t, result, raw, mixedHops(ids...))
			var persisted domain.PublishedRoute
			if err := s.Get("published-routes", "mixed-route", &persisted); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(persisted.Hops, mixedHops(ids...)) {
				t.Fatal("stored intent differs")
			}
		})
	}
}

func TestPublishedMixedPathsRejectUnstatedOrWrongConnectorOrder(t *testing.T) {
	for _, test := range []struct {
		name     string
		selected []string
	}{
		{"hidden", []string{"fra", "y", "uk"}},
		{"reverse", []string{"fra", "y", "x", "uk"}},
		{"missing", []string{"fra", "missing", "uk"}},
		{"cross-program", []string{"fra", "x", "y", "uk", "x"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, srv, _ := seedMixedPath(t, "fra", "x", "y", "uk")
			code, _, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/preview", "", mixedInput(test.selected...))
			if code != 422 {
				t.Fatalf("wrong chain accepted: %d %s", code, raw)
			}
			if strings.Contains(raw, mixedSecret) {
				t.Fatal("refusal leaked secret")
			}
		})
	}
}

func TestPublishedMixedPathsRejectOldEditorAndRetarget(t *testing.T) {
	_, srv, _ := seedMixedPath(t, "fra", "x", "uk")
	input := mixedInput("fra", "x", "uk")
	code, saved, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", input)
	if code != 200 {
		t.Fatalf("save: %d %s", code, raw)
	}
	for _, empty := range []bool{false, true} {
		old := map[string]any{"id": "mixed-route", "name": "Old editor", "deploymentId": "deployment", "endpointIds": []string{"fra", "uk"}, "publicHost": "10.0.0.1", "publicPort": 1080}
		if empty {
			old["hops"] = []domain.PublishedRouteHop{}
		}
		code, _, raw = putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/mixed-route", saved["revisionToken"].(string), old)
		if code != 422 {
			t.Fatalf("old editor: %d %s", code, raw)
		}
	}
	_, deployment, _ := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment", "", nil)
	change := map[string]any{"replacementEndpointId": "new-uk", "expectedRouteRevision": saved["revisionToken"], "expectedDeploymentRevision": deployment["revisionToken"]}
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/mixed-route/retarget/preview", "", change)
	if code != 422 {
		t.Fatalf("mixed retarget: %d %s", code, raw)
	}
}

// Synthetic observations exercise resolver fences only; no native apply occurs.
func recordMixedObservations(t *testing.T, s *store.Store, deployment httpapi.ServerDeployment, route domain.PublishedRoute, fingerprint string) {
	t.Helper()
	for _, p := range deployment.IR.Programs {
		scope := controlprotocol.Scope{NodeID: p.Instance.HostID, InstanceID: p.Instance.ID, EnrollmentEpoch: "enrollment"}
		desired := controlprotocol.Desired{Scope: scope, AdapterID: p.Instance.AdapterID, CoreVersion: p.Instance.Version, Generation: 1, RevisionID: "mixed-rev-" + p.Instance.ID, OperationID: "mixed-op-" + p.Instance.ID, Digest: "synthetic-artifact-digest"}
		identity := desired.Identity()
		state := controlprotocol.State{HighestAccepted: 1, Desired: &identity, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}}
		data, _ := json.Marshal(identity)
		var frozen domain.DeploymentIdentity
		if err := json.Unmarshal(data, &frozen); err != nil {
			t.Fatal(err)
		}
		manifest := domain.PublishedManifest{PolicyExpiresAt: time.Now().Add(time.Hour), DeploymentID: deployment.ID, Fingerprint: fingerprint, Identity: frozen, Program: p, Routes: []domain.PublishedRoute{route}}
		for _, record := range []struct {
			kind, id string
			value    any
		}{
			{"agent-desired", p.Instance.ID, desired}, {"agent-observations", p.Instance.ID, state}, {"published-manifests", desired.RevisionID, manifest}, {"instance-enrollments", p.Instance.ID, httpapi.Enrollment{Scope: scope, ExpiresAt: time.Now().Add(time.Hour)}},
		} {
			if err := s.Put(record.kind, record.id, record.value); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestPublishedMixedPathsFrozenSnapshotAndPendingChanges(t *testing.T) {
	s, srv, deployment := seedMixedPath(t, "fra", "x", "uk")
	code, saved, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", mixedInput("fra", "x", "uk"))
	if code != 200 {
		t.Fatalf("save: %d %s", code, raw)
	}
	var route domain.PublishedRoute
	if err := s.Get("published-routes", "mixed-route", &route); err != nil {
		t.Fatal(err)
	}
	recordMixedObservations(t, s, deployment, route, saved["fingerprint"].(string))
	code, result, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
	if code != 200 || result["status"] != "effective" || result["pendingChanges"] != false {
		t.Fatalf("matching snapshots: %d %s", code, raw)
	}
	effective, ok := result["effective"].(map[string]any)
	if !ok {
		t.Fatalf("effective snapshot missing: %s", raw)
	}
	data, _ := json.Marshal(effective["hops"])
	var effectiveHops []domain.PublishedRouteHop
	if err := json.Unmarshal(data, &effectiveHops); err != nil || !reflect.DeepEqual(effectiveHops, route.Hops) {
		t.Fatalf("effective hops flattened: %s", raw)
	}
	if strings.Contains(raw, mixedSecret) {
		t.Fatal("effective summary leaked connector secret")
	}
	// Only selected hops change, not deployment or managed projection.
	route.Hops = mixedHops("fra", "uk")
	if err := s.Put("published-routes", route.ID, route); err != nil {
		t.Fatal(err)
	}
	_, result, raw = req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
	if result["status"] != "effective" || result["pendingChanges"] != true {
		t.Fatalf("hop-only draft change hidden: %s", raw)
	}
	var transit domain.PublishedManifest
	if err := s.Get("published-manifests", "mixed-rev-uk-core", &transit); err != nil {
		t.Fatal(err)
	}
	transit.Routes[0].Hops = mixedHops("fra", "uk")
	if err := s.Put("published-manifests", "mixed-rev-uk-core", transit); err != nil {
		t.Fatal(err)
	}
	_, result, raw = req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
	if result["status"] == "effective" || result["effective"] != nil {
		t.Fatalf("different route snapshots combined: %s", raw)
	}
}

func TestPublishedMixedPathsTenantAuthorizationAndProjection(t *testing.T) {
	s, srv, _ := seedMixedPath(t, "fra", "x", "uk")
	tenant := inviteClient(t, s, srv, "mixed-tenant")
	input := mixedInput("fra", "x", "uk")
	code, _, raw := req(t, tenant.c, "POST", srv.URL+"/api/published-routes/preview", tenant.csrf, input)
	if code != 403 {
		t.Fatalf("tenant preview authorized: %d %s", code, raw)
	}
	input["endpointIds"] = []string{"fra"}
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/preview", "", input)
	if code != 422 {
		t.Fatalf("mismatching projection accepted: %d %s", code, raw)
	}
}

func TestPublishedMixedPathsPrincipalRemainsPendingBeforeApplication(t *testing.T) {
	s, srv, deployment := seedMixedPath(t, "fra", "x", "uk")
	// Replace the fixture principal with an actual provisioned account credential.
	deployment.IR.Programs[0].Principals = nil
	if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
		t.Fatal(err)
	}
	tenant := inviteClient(t, s, srv, "mixed-grant-user")
	admin := operatorClient()
	code, _, raw := req(t, admin, "POST", srv.URL+"/api/published-routes", "", mixedInput("fra", "x", "uk"))
	if code != 200 {
		t.Fatalf("route: %d %s", code, raw)
	}
	plan := service.Plan{ID: "mixed-plan", Name: "Mixed service", QuotaBytes: 1 << 20, RouteIDs: []string{"mixed-route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	code, _, raw = req(t, admin, "POST", srv.URL+"/api/services", "", plan)
	if code != 200 {
		t.Fatalf("service: %d %s", code, raw)
	}
	code, _, raw = req(t, admin, "PUT", srv.URL+"/api/users/"+tenant.id+"/entitlement", "", service.Entitlement{ServiceID: plan.ID, Cycle: plan.Cycle})
	if code != 200 {
		t.Fatalf("entitlement: %d %s", code, raw)
	}
	code, grant, raw := req(t, admin, "POST", srv.URL+"/api/published-routes/mixed-route/principals", "", map[string]any{"accountId": tenant.id, "entryId": "mixed-entry", "credentialVersion": "v1"})
	if code != 200 || grant["status"] != "pending-deployment" {
		t.Fatalf("principal: %d %s", code, raw)
	}
	if strings.Contains(raw, mixedSecret) {
		t.Fatal("principal summary leaked connector credential")
	}
	if err := s.Get("server-deployments", deployment.ID, &deployment); err != nil {
		t.Fatal(err)
	}
	principals := deployment.IR.Programs[0].Principals
	if len(principals) != 1 || principals[0].RouteID != "mixed-route" || principals[0].Action != (domain.ActionRef{Kind: "forward", Ref: "to-uk"}) {
		t.Fatalf("principal selected wrong chain: %#v", principals)
	}
	reveal := srv.URL + "/api/users/" + tenant.id + "/entries/mixed-entry/reveal"
	code, _, raw = req(t, admin, "GET", reveal, "", nil)
	if code != 409 {
		t.Fatalf("unapplied credential revealed: %d %s", code, raw)
	}
	if strings.Contains(raw, mixedSecret) {
		t.Fatal("unapplied response leaked connector credential")
	}
}
