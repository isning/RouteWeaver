package httpapi_test

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestActionsUseCurrentOwnerComparisonWithoutPublishing(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "action-owner")
	other := inviteClient(t, s, srv, "action-other")
	p := templateTestProfile("action-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "phone", "name": "phone", "profileId": p.ID, "target": p.Target})
	if code != 201 {
		t.Fatal(raw)
	}
	var before httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "phone", &before); err != nil {
		t.Fatal(err)
	}
	read := func(c *http.Client, kind string, partial bool) {
		t.Helper()
		code, v, raw := req(t, c, "GET", srv.URL+"/api/me/actions", "", nil)
		if code != 200 || v["partial"] != partial {
			t.Fatalf("actions: %d %s", code, raw)
		}
		items := v["items"].([]any)
		if kind == "" {
			if len(items) != 0 {
				t.Fatal(raw)
			}
		} else if len(items) != 1 || items[0].(map[string]any)["kind"] != kind {
			t.Fatal(raw)
		}
		for _, secret := range []string{"secret-password", "changed-password", "private-user", "tokenDigest", "routingIntent", "artifacts"} {
			if strings.Contains(raw, secret) {
				t.Fatalf("leaked %s: %s", secret, raw)
			}
		}
	}
	read(owner.c, "", false)
	p.IR.Endpoints[0].Connection.Password = "changed-password"
	code, _, raw = putCurrentProfileDraft(t, owner, srv.URL+"/api/me/profiles/"+p.ID, p)
	if code != 200 {
		t.Fatal(raw)
	}
	read(owner.c, "output-changed", false)
	read(other.c, "", false)
	// Persist an invalid draft to exercise the same typed failure as selected review.
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"}
	if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
		t.Fatal(err)
	}
	read(owner.c, "output-reference-missing", false)
	var after httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "phone", &after); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("read mutated publication")
	}
	code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+"/api/me/actions", "", nil)
	if code != 401 {
		t.Fatalf("unauthenticated: %d", code)
	}
	// Unknown and oversized input must not turn into a clean bill of health.
	p.Name = strings.Repeat("x", 600<<10)
	if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
		t.Fatal(err)
	}
	read(owner.c, "", true)
}

func TestActionsBoundComparisonsAndRequirePlatformEligibility(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "action-bounds")
	p := templateTestProfile("action-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
		t.Fatal(err)
	}
	// Oversized/unknown records and more than eight publications are partial.
	for i := 0; i < 9; i++ {
		v := httpapi.Output{ID: fmt.Sprintf("output-%02d", i), Name: "Subscription", ProfileID: p.ID, Status: "published", Target: p.Target}
		if err := s.TenantPut(owner.id, "outputs", v.ID, v); err != nil {
			t.Fatal(err)
		}
	}
	code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
	if code != 200 || v["partial"] != true {
		t.Fatalf("bounded summary: %d %s", code, raw)
	}

	var output httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "output-00", &output); err != nil {
		t.Fatal(err)
	}
	output.PlatformDependencies = []httpapi.EntryDependency{{ID: "entry", RouteID: "quota-route"}}
	if err := s.TenantPut(owner.id, "outputs", output.ID, output); err != nil {
		t.Fatal(err)
	}
	code, v, raw = req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
	if code != 200 || v["platformRoutesComplete"] != true || !reflect.DeepEqual(v["platformRouteIds"], []any{"quota-route"}) {
		t.Fatalf("platform inventory: %d %s", code, raw)
	}
	// A truncated inventory never grants positive quota/expiry relevance.
	for i := 9; i < 33; i++ {
		output.ID = fmt.Sprintf("output-%02d", i)
		if err := s.TenantPut(owner.id, "outputs", output.ID, output); err != nil {
			t.Fatal(err)
		}
	}
	code, v, raw = req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
	if code != 200 || v["partial"] != true || v["platformRoutesComplete"] != false || len(v["platformRouteIds"].([]any)) != 0 {
		t.Fatalf("truncated inventory: %d %s", code, raw)
	}
}
