package httpapi_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"testing"
)

func TestPublishedMixedMetadataPreservesTopologyAndRejectsStale(t *testing.T) {
	for _, ids := range [][]string{{"fra", "x"}, {"fra", "x", "uk", "y"}} {
		t.Run(ids[len(ids)-1], func(t *testing.T) {
			s, srv, _ := seedMixedPath(t, ids...)
			in := mixedInput(ids...)
			code, saved, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", in)
			if code != 200 {
				t.Fatalf("create %d %s", code, body)
			}
			var before domain.PublishedRoute
			if err := s.Get("published-routes", "mixed-route", &before); err != nil {
				t.Fatal(err)
			}
			var deploymentBefore json.RawMessage
			if err := s.Get("server-deployments", "deployment", &deploymentBefore); err != nil {
				t.Fatal(err)
			}
			in["endpointIds"] = before.EndpointIDs
			in["name"] = "Renamed route"
			in["publicHost"] = "10.0.0.9"
			in["publicPort"] = 1443
			code, out, body := putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/mixed-route", saved["revisionToken"].(string), in)
			if code != 200 {
				t.Fatalf("metadata %d %s", code, body)
			}
			assertMixedPublicSummary(t, out, body, before.Hops)
			var after domain.PublishedRoute
			if err := s.Get("published-routes", "mixed-route", &after); err != nil {
				t.Fatal(err)
			}
			want := before
			want.Name = "Renamed route"
			want.PublicHost = "10.0.0.9"
			want.PublicPort = 1443
			if !reflect.DeepEqual(after, want) {
				t.Fatal("metadata update changed topology or failed requested edit")
			}
			var deploymentAfter json.RawMessage
			if err := s.Get("server-deployments", "deployment", &deploymentAfter); err != nil {
				t.Fatal(err)
			}
			if string(deploymentAfter) != string(deploymentBefore) {
				t.Fatal("metadata update changed server credentials or programs")
			}
			in["name"] = "Stale overwrite"
			code, _, _ = putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/mixed-route", saved["revisionToken"].(string), in)
			if code != 409 {
				t.Fatalf("stale metadata status %d", code)
			}
			if err := s.Get("published-routes", "mixed-route", &after); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, want) {
				t.Fatal("stale edit mutated route")
			}
		})
	}
}

func TestPublishedMixedMetadataRefusesUnknownStoredIntent(t *testing.T) {
	for _, location := range []string{"top", "hop", "path"} {
		t.Run(location, func(t *testing.T) {
			s, srv, _ := seedMixedPath(t, "fra", "x", "uk")
			in := mixedInput("fra", "x", "uk")
			code, _, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", in)
			if code != 200 {
				t.Fatalf("create %d %s", code, body)
			}
			var raw map[string]any
			if err := s.Get("published-routes", "mixed-route", &raw); err != nil {
				t.Fatal(err)
			}
			switch location {
			case "top":
				raw["futurePolicy"] = true
			case "hop":
				raw["hops"].([]any)[1].(map[string]any)["futurePolicy"] = true
			case "path":
				raw["path"].(map[string]any)["futurePolicy"] = true
			}
			if err := s.Put("published-routes", "mixed-route", raw); err != nil {
				t.Fatal(err)
			}
			var before json.RawMessage
			if err := s.Get("published-routes", "mixed-route", &before); err != nil {
				t.Fatal(err)
			}
			code, current, body := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
			if code != 200 {
				t.Fatalf("resolve %d %s", code, body)
			}
			in["name"] = "Must not erase unknown intent"
			code, _, _ = putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/mixed-route", current["revisionToken"].(string), in)
			if code != 422 {
				t.Fatalf("unknown %s status %d", location, code)
			}
			var after json.RawMessage
			if err := s.Get("published-routes", "mixed-route", &after); err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("unsupported stored intent changed")
			}
		})
	}
}
