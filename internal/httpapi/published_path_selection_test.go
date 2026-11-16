package httpapi_test

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func pathSelectionFixture(t *testing.T) (*store.Store, *httptest.Server, httpapi.ServerDeployment, map[string]any) {
	t.Helper()
	s, srv, d := seedMixedPath(t, "fra", "x", "uk")
	code, old, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", mixedInput("fra", "x", "uk"))
	if code != 200 {
		t.Fatalf("create %d %s", code, body)
	}
	// An administrator has already saved a new full forwarding chain. This task
	// selects it without rewriting those programs, principals or credentials.
	d.IR.Programs[0].Connectors[0].ID = "y"
	d.IR.Programs[0].Connectors[1].Via = "y"
	d.IR.Programs[0].Principals[0].RouteID = "mixed-route"
	if err := s.Put("server-deployments", d.ID, d); err != nil {
		t.Fatal(err)
	}
	return s, srv, d, map[string]any{"expectedRouteRevision": old["revisionToken"], "hops": mixedHops("fra", "y", "uk")}
}
func TestPublishedPathSelectionReviewCommit(t *testing.T) {
	s, srv, d, in := pathSelectionFixture(t)
	d.IR.Programs[0].Principals = nil
	if err := s.Put("server-deployments", d.ID, d); err != nil {
		t.Fatal(err)
	}
	var old domain.PublishedRoute
	if err := s.Get("published-routes", "mixed-route", &old); err != nil {
		t.Fatal(err)
	}
	var depBefore json.RawMessage
	if err := s.Get("server-deployments", "deployment", &depBefore); err != nil {
		t.Fatal(err)
	}
	url := srv.URL + "/api/published-routes/mixed-route/path-selection"
	code, review, body := req(t, operatorClient(), "POST", url+"/preview", "", in)
	if code != 200 || review["status"] != "reviewed" {
		t.Fatalf("review %d %s", code, body)
	}
	if strings.Contains(body, mixedSecret) || strings.Contains(body, "proxy-user") || strings.Contains(body, "example.invalid") || strings.Contains(body, "33333333") {
		t.Fatal("review leaked credentials")
	}
	var after domain.PublishedRoute
	if err := s.Get("published-routes", "mixed-route", &after); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(old, after) {
		t.Fatal("review wrote route")
	}
	in["reviewToken"] = review["reviewToken"]
	code, result, body := req(t, operatorClient(), "POST", url, "", in)
	if code != 200 || result["status"] != "draft-saved" || result["revisionToken"] == in["expectedRouteRevision"] {
		t.Fatalf("commit %d %s", code, body)
	}
	if err := s.Get("published-routes", "mixed-route", &after); err != nil {
		t.Fatal(err)
	}
	want := old
	want.Hops = mixedHops("fra", "y", "uk")
	if !reflect.DeepEqual(after, want) {
		t.Fatal("selected path changed unrelated route fields")
	}
	var depAfter json.RawMessage
	if err := s.Get("server-deployments", "deployment", &depAfter); err != nil {
		t.Fatal(err)
	}
	if string(depBefore) != string(depAfter) {
		t.Fatal("commit changed deployment bytes")
	}
	code, _, _ = req(t, operatorClient(), "POST", url, "", in)
	if code != 409 {
		t.Fatalf("stale replay %d", code)
	}
}
func TestPublishedPathSelectionReviewFences(t *testing.T) {
	for _, kind := range []string{"route", "credential", "host", "instance", "endpoint", "link-change", "link-delete", "token", "candidate"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, d, in := pathSelectionFixture(t)
			url := srv.URL + "/api/published-routes/mixed-route/path-selection"
			code, review, body := req(t, operatorClient(), "POST", url+"/preview", "", in)
			if code != 200 {
				t.Fatalf("review %d %s", code, body)
			}
			in["reviewToken"] = review["reviewToken"]
			switch kind {
			case "route":
				var r domain.PublishedRoute
				if err := s.Get("published-routes", "mixed-route", &r); err != nil {
					t.Fatal(err)
				}
				r.Name = "new name"
				if err := s.Put("published-routes", r.ID, r); err != nil {
					t.Fatal(err)
				}
			case "credential":
				d.IR.Programs[0].Connectors[0].Connection.Password = "changed-secret"
				if err := s.Put("server-deployments", d.ID, d); err != nil {
					t.Fatal(err)
				}
			case "host":
				var h domain.Host
				if err := s.Get("hosts", "fra-host", &h); err != nil {
					t.Fatal(err)
				}
				h.Name = "renamed"
				if err := s.Put("hosts", h.ID, h); err != nil {
					t.Fatal(err)
				}
			case "instance":
				var c domain.CoreInstance
				if err := s.Get("core-instances", "fra-core", &c); err != nil {
					t.Fatal(err)
				}
				c.HostID = "uk-host"
				if err := s.Put("core-instances", c.ID, c); err != nil {
					t.Fatal(err)
				}
			case "endpoint":
				var e domain.ManagedEndpoint
				if err := s.Get("managed-endpoints", "fra", &e); err != nil {
					t.Fatal(err)
				}
				e.Name = "new endpoint name"
				if err := s.Put("managed-endpoints", e.ID, e); err != nil {
					t.Fatal(err)
				}
			case "link-change", "link-delete":
				var route domain.PublishedRoute
				if err := s.Get("published-routes", "mixed-route", &route); err != nil {
					t.Fatal(err)
				}
				linkID := route.Path.Links[0]
				if kind == "link-delete" {
					var linkRaw json.RawMessage
					if err := s.Get("links", linkID, &linkRaw); err != nil {
						t.Fatal(err)
					}
					if err := s.CompareSetsAndRemoveRecord("links", linkID, []store.RecordCompare{{Kind: "links", ID: linkID, Expected: linkRaw}}, nil); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := s.Put("links", linkID, domain.Link{ID: linkID, From: "fra", To: "new-uk"}); err != nil {
						t.Fatal(err)
					}
				}
			case "token":
				in["reviewToken"] = "invalid"
			case "candidate":
				in["hops"] = mixedHops("fra", "x", "uk")
			}
			var before json.RawMessage
			if err := s.Get("published-routes", "mixed-route", &before); err != nil {
				t.Fatal(err)
			}
			code, _, _ = req(t, operatorClient(), "POST", url, "", in)
			if code != 409 && code != 422 {
				t.Fatalf("stale dependency accepted %d", code)
			}
			var after json.RawMessage
			if err := s.Get("published-routes", "mixed-route", &after); err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("failed commit changed route")
			}
		})
	}
}
func TestPublishedPathSelectionRefusesUnsupported(t *testing.T) {
	for _, kind := range []string{"unknown-route", "unknown-hop", "unknown-deployment", "unknown-connector", "ingress", "principal", "default", "empty"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, d, in := pathSelectionFixture(t)
			switch kind {
			case "unknown-route", "unknown-hop":
				var r map[string]any
				if err := s.Get("published-routes", "mixed-route", &r); err != nil {
					t.Fatal(err)
				}
				if kind == "unknown-route" {
					r["future"] = true
				} else {
					r["hops"].([]any)[1].(map[string]any)["future"] = true
				}
				if err := s.Put("published-routes", "mixed-route", r); err != nil {
					t.Fatal(err)
				}
			case "unknown-deployment", "unknown-connector":
				var r map[string]any
				if err := s.Get("server-deployments", "deployment", &r); err != nil {
					t.Fatal(err)
				}
				if kind == "unknown-deployment" {
					r["future"] = true
				} else {
					r["ir"].(map[string]any)["programs"].([]any)[0].(map[string]any)["connectors"].([]any)[0].(map[string]any)["future"] = true
				}
				if err := s.Put("server-deployments", "deployment", r); err != nil {
					t.Fatal(err)
				}
			case "ingress":
				in["hops"] = mixedHops("uk")
			case "principal":
				d.IR.Programs[0].Principals[0].Action = domain.ActionRef{Kind: "direct"}
				if err := s.Put("server-deployments", d.ID, d); err != nil {
					t.Fatal(err)
				}
			case "default":
				d.IR.Programs[0].DefaultAction = domain.ActionRef{Kind: "direct"}
				d.IR.Programs[0].Principals = nil
				if err := s.Put("server-deployments", d.ID, d); err != nil {
					t.Fatal(err)
				}
			case "empty":
				in["hops"] = []domain.PublishedRouteHop{}
			}
			_, current, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/mixed-route/resolve", "", nil)
			in["expectedRouteRevision"] = current["revisionToken"]
			code, _, _ := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/mixed-route/path-selection/preview", "", in)
			if code != 422 {
				t.Fatalf("unsupported %s status %d", kind, code)
			}
		})
	}
}

func TestPublishedPathSelectionAdminAndConcurrentCommit(t *testing.T) {
	s, srv, _, in := pathSelectionFixture(t)
	url := srv.URL + "/api/published-routes/mixed-route/path-selection"
	user := inviteClient(t, s, srv, "path-selection-tenant")
	for _, suffix := range []string{"/preview", ""} {
		code, _, body := req(t, user.c, "POST", url+suffix, user.csrf, in)
		if code != 403 || strings.Contains(body, mixedSecret) {
			t.Fatalf("tenant access %d", code)
		}
	}
	code, review, body := req(t, operatorClient(), "POST", url+"/preview", "", in)
	if code != 200 {
		t.Fatalf("review %d %s", code, body)
	}
	in["reviewToken"] = review["reviewToken"]
	var account store.Account
	if err := s.Get("accounts", user.id, &account); err != nil {
		t.Fatal(err)
	}
	account.Role = "admin"
	if err := s.Put("accounts", user.id, account); err != nil {
		t.Fatal(err)
	}
	code, _, _ = req(t, user.c, "POST", url, user.csrf, in)
	if code != 409 {
		t.Fatalf("different administrator reused review: %d", code)
	}
	results := make(chan int, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		go func() { <-start; status, _, _ := req(t, operatorClient(), "POST", url, "", in); results <- status }()
	}
	close(start)
	a, b := <-results, <-results
	if !((a == 200 && b == 409) || (a == 409 && b == 200)) {
		t.Fatalf("concurrent status %d %d", a, b)
	}
}
func TestPublishedPathSelectionNoChangeIsNotSaved(t *testing.T) {
	s, srv, _ := seedMixedPath(t, "fra", "x", "uk")
	code, old, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes", "", mixedInput("fra", "x", "uk"))
	if code != 200 {
		t.Fatalf("create %d %s", code, body)
	}
	var before json.RawMessage
	if err := s.Get("published-routes", "mixed-route", &before); err != nil {
		t.Fatal(err)
	}
	in := map[string]any{"expectedRouteRevision": old["revisionToken"], "hops": mixedHops("fra", "x", "uk")}
	code, _, _ = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/mixed-route/path-selection/preview", "", in)
	if code != 422 {
		t.Fatalf("no change %d", code)
	}
	var after json.RawMessage
	if err := s.Get("published-routes", "mixed-route", &after); err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("no change wrote route")
	}
}
