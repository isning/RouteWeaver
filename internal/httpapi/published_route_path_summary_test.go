package httpapi_test

import (
	"reflect"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"testing"
)

func TestPublishedRoutePathSummaryKeepsSavedAndConfirmedSnapshotNames(t *testing.T) {
	s, srv, deployment, old, next := newRetargetFixture(t)
	recordOldRetargetObservations(t, s, srv, deployment)
	input := retargetInput(t, srv)
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("preview %d %s", code, raw)
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "snapshot-names"
	code, receipt, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 || receipt["status"] != "draft-saved" {
		t.Fatalf("save %d %s", code, raw)
	}
	old.Name = "Catalog renamed old exit"
	next.Name = "Catalog renamed new exit"
	if err := s.Put("managed-endpoints", old.ID, old); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("managed-endpoints", next.ID, next); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"renamed", "deleted"} {
		if phase == "deleted" {
			if err := s.Remove("managed-endpoints", old.ID); err != nil {
				t.Fatal(err)
			}
			if err := s.Remove("managed-endpoints", next.ID); err != nil {
				t.Fatal(err)
			}
		}
		code, resolved, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
		if code != 200 || resolved["status"] != "effective" {
			t.Fatalf("%s resolve %d %s", phase, code, raw)
		}
		saved := map[string]any{"hops": []any{
			map[string]any{"endpointId": "fra", "name": "FRA", "metadataState": "snapshot"},
			map[string]any{"endpointId": "new-uk", "name": "New UK", "metadataState": "snapshot"},
		}}
		confirmed := map[string]any{"hops": []any{
			map[string]any{"endpointId": "fra", "name": "FRA", "metadataState": "snapshot"},
			map[string]any{"endpointId": "uk", "name": "Old UK", "metadataState": "snapshot"},
		}}
		if !reflect.DeepEqual(resolved["savedPath"], saved) {
			t.Fatalf("%s saved summary: %s", phase, raw)
		}
		effective := resolved["effective"].(map[string]any)
		if !reflect.DeepEqual(effective["path"], confirmed) {
			t.Fatalf("%s confirmed summary: %s", phase, raw)
		}
	}
}

func TestPublishedRoutePathSummaryDoesNotInventConfirmedMetadata(t *testing.T) {
	for _, failure := range []string{"unobserved", "recovery", "missing-hop", "mismatched-hop"} {
		t.Run(failure, func(t *testing.T) {
			s, srv, deployment, _, _ := newRetargetFixture(t)
			if failure != "unobserved" {
				recordOldRetargetObservations(t, s, srv, deployment)
			}
			if failure == "missing-hop" {
				if err := s.Remove("published-manifests", "rev_uk-core"); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "recovery" {
				var state controlprotocol.State
				if err := s.Get("agent-observations", "uk-core", &state); err != nil {
					t.Fatal(err)
				}
				state.RecoveryRequired = true
				if err := s.Put("agent-observations", "uk-core", state); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "mismatched-hop" {
				var manifest domain.PublishedManifest
				if err := s.Get("published-manifests", "rev_uk-core", &manifest); err != nil {
					t.Fatal(err)
				}
				manifest.Fingerprint = "unrelated-configuration"
				if err := s.Put("published-manifests", "rev_uk-core", manifest); err != nil {
					t.Fatal(err)
				}
			}
			code, resolved, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
			if code != 200 || resolved["effective"] != nil || resolved["status"] == "effective" {
				t.Fatalf("invented confirmation %d %s", code, raw)
			}
			if resolved["savedPath"] == nil {
				t.Fatalf("saved metadata missing %s", raw)
			}
		})
	}
}

func TestPublishedRoutePathSummaryMissingOrAmbiguousSavedProgramUsesIdentity(t *testing.T) {
	for _, failure := range []string{"missing", "duplicate"} {
		t.Run(failure, func(t *testing.T) {
			s, srv, deployment, _, _ := newRetargetFixture(t)
			if failure == "missing" {
				deployment.IR.Programs = deployment.IR.Programs[:1]
			} else {
				deployment.IR.Programs = append(deployment.IR.Programs, deployment.IR.Programs[1])
			}
			if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
				t.Fatal(err)
			}
			code, resolved, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
			if code != 200 {
				t.Fatalf("resolve %d %s", code, raw)
			}
			path, ok := resolved["savedPath"].(map[string]any)
			if !ok {
				t.Fatalf("missing path %s", raw)
			}
			hops := path["hops"].([]any)
			if len(hops) != 2 || !reflect.DeepEqual(hops[1], map[string]any{"endpointId": "uk", "metadataState": "unavailable"}) {
				t.Fatalf("guessed metadata %s", raw)
			}
		})
	}
}
