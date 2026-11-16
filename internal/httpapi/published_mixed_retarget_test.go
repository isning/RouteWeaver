package httpapi_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/store"
)

func TestMixedRetargetPreservesPrefixAndOtherRoute(t *testing.T) {
	s, srv, d := seedMixedPath(t, "fra", "x", "uk")
	_, opened, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
	input := mixedInput("fra", "x", "uk")
	input["id"] = "route"
	code, _, body := putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/route", opened["revisionToken"].(string), input)
	if code != 200 {
		t.Fatalf("mixed route %d %s", code, body)
	}
	var original domain.PublishedRoute
	if err := s.Get("published-routes", "route", &original); err != nil {
		t.Fatal(err)
	}
	other := original
	other.ID = "other-route"
	other.Path.ID = "other-route"
	if err := s.Put("published-routes", other.ID, other); err != nil {
		t.Fatal(err)
	}
	principal := d.IR.Programs[0].Principals[0]
	principal.RouteID = other.ID
	principal.SubjectID = "other-subject"
	principal.AccountID = "other-user"
	principal.Credential.UUID = "44444444-4444-4444-8444-444444444444"
	d.IR.Programs[0].Principals = append(d.IR.Programs[0].Principals, principal)
	if err := s.Put("server-deployments", d.ID, d); err != nil {
		t.Fatal(err)
	}
	in := retargetInput(t, srv)
	code, review, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", in)
	if code != 200 {
		t.Fatalf("review %d %s", code, body)
	}
	if review["beforePath"] == nil || review["afterPath"] == nil || strings.Contains(body, mixedSecret) || strings.Contains(body, "proxy-user") {
		t.Fatal("missing complete safe path review")
	}
	in["reviewToken"] = review["reviewToken"]
	in["operationId"] = "mixed-retarget"
	code, result, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", in)
	if code != 200 || result["status"] != "draft-saved" {
		t.Fatalf("commit %d %s", code, body)
	}
	var got httpapi.ServerDeployment
	if err := s.Get("server-deployments", d.ID, &got); err != nil {
		t.Fatal(err)
	}
	entry := got.IR.Programs[0]
	if !reflect.DeepEqual(entry.Connectors[:len(d.IR.Programs[0].Connectors)], d.IR.Programs[0].Connectors) || entry.DefaultAction != d.IR.Programs[0].DefaultAction || !reflect.DeepEqual(entry.Principals[1], principal) {
		t.Fatal("shared prefix, fallback or other principal changed")
	}
	if len(entry.Connectors) != len(d.IR.Programs[0].Connectors)+1 || entry.Connectors[len(entry.Connectors)-1].Via != "x" {
		t.Fatal("new terminal did not retain external prefix")
	}
	var route domain.PublishedRoute
	if err := s.Get("published-routes", "route", &route); err != nil {
		t.Fatal(err)
	}
	if route.Hops[1] != original.Hops[1] || route.Hops[0] != original.Hops[0] || route.Hops[2].EndpointID != "new-uk" || route.PublicHost != original.PublicHost || route.PublicPort != original.PublicPort {
		t.Fatal("original ingress or prefix lost")
	}
	var otherAfter domain.PublishedRoute
	if err := s.Get("published-routes", other.ID, &otherAfter); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(other, otherAfter) {
		t.Fatal("unrelated route changed")
	}
}

func TestMixedRetargetRejectsCanonicalIndependentReference(t *testing.T) {
	for _, scenario := range []string{"reserved-without-queue", "cancelled-without-queue", "unknown-intent", "orphan-grant", "migration", "lock", "isolated-principal", "record-added-after-review"} {
		t.Run(scenario, func(t *testing.T) {
			s, srv, _ := seedMixedPath(t, "fra", "x", "uk")
			_, opened, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
			candidate := mixedInput("fra", "x", "uk")
			candidate["id"] = "route"
			code, _, body := putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/route", opened["revisionToken"].(string), candidate)
			if code != 200 {
				t.Fatalf("seed %d %s", code, body)
			}
			in := retargetInput(t, srv)
			add := func() {
				if scenario == "isolated-principal" {
					var d httpapi.ServerDeployment
					if err := s.Get("server-deployments", "deployment", &d); err != nil {
						t.Fatal(err)
					}
					d.IR.Programs[0].Principals[0].CredentialVersion = "out_or_revision"
					if err := s.Put("server-deployments", "deployment", d); err != nil {
						t.Fatal(err)
					}
					return
				}
				if scenario == "migration" {
					if err := s.Put("principal-service-migrations", "migration", map[string]any{"id": "migration", "owner": "orphan-owner", "outputId": "output", "outputRevision": "revision", "deploymentId": "deployment", "state": "applied"}); err != nil {
						t.Fatal(err)
					}
					return
				}
				if scenario == "lock" {
					if err := s.Put("principal-provisioning-locks", "deployment", map[string]any{"owner": "orphan-owner", "outputId": "output", "outputRevision": "revision", "migrationId": "migration"}); err != nil {
						t.Fatal(err)
					}
					return
				}

				if scenario == "orphan-grant" {
					if err := s.TenantPut("orphan-owner", "platform-entries", "isolated", httpapi.PublicEntryGrant{ID: "isolated", UserID: "orphan-owner", RouteID: "route", PublishedRouteID: "route", DeploymentID: "deployment", SubjectID: "isolated-subject", CredentialVersion: "out-rev", OutputID: "output", OutputRevision: "revision"}); err != nil {
						t.Fatal(err)
					}
					return
				}
				state := "reserved"
				if scenario == "cancelled-without-queue" {
					state = "cancelled"
				}
				record := map[string]any{"id": "output", "owner": "orphan-owner", "revision": "revision", "state": state, "plans": []any{map[string]any{"originalGrantId": "old", "instanceId": "fra-core", "entryId": "fra", "grant": map[string]any{"id": "isolated", "userId": "orphan-owner", "routeId": "route", "deploymentId": "deployment", "outputId": "output", "outputRevision": "revision"}, "principal": map[string]any{"subjectId": "isolated-subject", "accountId": "orphan-owner", "routeId": "route"}}}}
				if scenario == "unknown-intent" {
					record["futureSemantic"] = true
				}
				if err := s.TenantPut("orphan-owner", "output-attribution-intents", "output", record); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "record-added-after-review" {
				add()
				in = retargetInput(t, srv)
			}
			var before json.RawMessage
			if err := s.Get("server-deployments", "deployment", &before); err != nil {
				t.Fatal(err)
			}
			code, review, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", in)
			if scenario == "record-added-after-review" {
				if code != 200 {
					t.Fatalf("review %d %s", code, body)
				}
				add()
				in["reviewToken"] = review["reviewToken"]
				in["operationId"] = "rejected-mixed"
				code, result, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", in)
				if code != 200 || result["status"] != "draft-rejected" {
					t.Fatalf("late reference %d %s", code, body)
				}
			} else if code != 422 {
				t.Fatalf("independent reference accepted %d %s", code, body)
			}
			var after json.RawMessage
			if err := s.Get("server-deployments", "deployment", &after); err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("refusal changed deployment")
			}
		})
	}
}

func TestMixedRetargetAllowsUnrelatedRealAttributionHistory(t *testing.T) {
	f := newActionsAttributedFixture(t)
	s, srv, _ := seedMixedPath(t, "fra", "x", "uk")
	// Copy canonical unrelated records as a restored historical fixture, including
	// real composite SQL keys; no account list or queue is used for discovery.
	for _, tail := range []string{"platform-entries", "output-attribution-intents"} {
		rows, err := f.s.TenantList(f.owner.id, tail)
		if err != nil {
			t.Fatal(err)
		}
		for _, raw := range rows {
			var identity struct {
				ID string `json:"id"`
			}
			if err = json.Unmarshal(raw, &identity); err != nil {
				t.Fatal(err)
			}
			if err = s.TenantPut(f.owner.id, tail, identity.ID, raw); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, kind := range []string{"entry-admission-bindings", "output-attribution-claims", "principal-service-migrations"} {
		rows, err := f.s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		for _, raw := range rows {
			var identity struct {
				ID string `json:"id"`
			}
			if err = json.Unmarshal(raw, &identity); err != nil {
				t.Fatal(err)
			}
			id := identity.ID
			if kind == "entry-admission-bindings" {
				var b store.EntryAdmissionBinding
				if err = json.Unmarshal(raw, &b); err != nil {
					t.Fatal(err)
				}
				w, e := store.EntryAdmissionBindingRecord(b)
				if e != nil {
					t.Fatal(e)
				}
				id = w.ID
			}
			if kind == "output-attribution-claims" {
				var c store.OutputAttributionClaim
				if err = json.Unmarshal(raw, &c); err != nil {
					t.Fatal(err)
				}
				w, e := store.EntryAdmissionBindingRecord(c.Binding)
				if e != nil {
					t.Fatal(e)
				}
				id = w.ID
			}
			if err = s.Put(kind, id, raw); err != nil {
				t.Fatal(err)
			}
		}
	}
	_, opened, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
	candidate := mixedInput("fra", "x", "uk")
	candidate["id"] = "route"
	code, _, body := putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/route", opened["revisionToken"].(string), candidate)
	if code != 200 {
		t.Fatalf("seed %d %s", code, body)
	}
	input := retargetInput(t, srv)
	code, _, body = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("unrelated real independent records blocked %d %s", code, body)
	}
}
