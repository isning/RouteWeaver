package httpapi_test

import (
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestActionsCompareSmallPlatformGraphWithoutPublishing(t *testing.T) {
	for _, adapter := range []string{"mihomo", "sing-box"} {
		t.Run(adapter, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "platform-actions")
			other := inviteClient(t, s, srv, "platform-other")
			route := domain.Route{ID: "r", Name: "Route", UserIDs: []string{owner.id}}
			if err := s.Put("routes", route.ID, route); err != nil {
				t.Fatal(err)
			}
			grant := httpapi.PublicEntryGrant{ID: "entry", Name: "Entry", UserID: owner.id, RouteID: "r", CredentialVersion: "v1", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.10", Port: 1080, Username: "synthetic", Password: "private-platform-secret"}}
			if err := s.TenantPut(owner.id, "platform-entries", grant.ID, grant); err != nil {
				t.Fatal(err)
			}
			target := render.Target{AdapterID: adapter, Version: render.MihomoVersion}
			if adapter == "sing-box" {
				target.Version = render.SingBoxVersion
			}
			p := httpapi.Profile{ID: "p", Name: "Platform", Target: target, Mode: render.FullConfig, PlatformEntryIDs: []string{"entry"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", Endpoints: []domain.ClientEndpoint{{ID: "external", Name: "External", Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.11", Port: 1080}}}, DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "entry"}}}
			if code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p); code != 200 {
				t.Fatal(raw)
			}
			if code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]string{"id": "o", "name": "Output", "profileId": "p"}); code != 201 {
				t.Fatal(raw)
			}
			var published httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "o", &published); err != nil {
				t.Fatal(err)
			}
			check := func(changed, unchecked bool) {
				t.Helper()
				code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
				if code != 200 || v["partial"] != unchecked {
					t.Fatal(raw)
				}
				items := v["items"].([]any)
				if (len(items) == 1) != changed || (changed && items[0].(map[string]any)["kind"] != "output-changed") {
					t.Fatal(raw)
				}
				if (len(v["uncheckedOutputs"].([]any)) == 1) != unchecked {
					t.Fatal(raw)
				}
				if strings.Contains(raw, "private-platform-secret") {
					t.Fatal("secret exposed")
				}
			}
			check(false, false)
			grant.Connection.Port = 1081
			if err := s.TenantPut(owner.id, "platform-entries", grant.ID, grant); err != nil {
				t.Fatal(err)
			}
			check(true, false)
			grant.Revoked = true
			if err := s.TenantPut(owner.id, "platform-entries", grant.ID, grant); err != nil {
				t.Fatal(err)
			}
			check(false, true)
			grant.Revoked = false
			grant.UserID = other.id
			if err := s.TenantPut(owner.id, "platform-entries", grant.ID, grant); err != nil {
				t.Fatal(err)
			}
			check(false, true)
			grant.UserID = owner.id
			if err := s.TenantPut(owner.id, "platform-entries", grant.ID, grant); err != nil {
				t.Fatal(err)
			}
			route.UserIDs = nil
			if err := s.Put("routes", route.ID, route); err != nil {
				t.Fatal(err)
			}
			check(false, true)
			route.UserIDs = []string{owner.id}
			if err := s.Put("routes", route.ID, route); err != nil {
				t.Fatal(err)
			}
			check(true, false)
			// Unsupported large mixed dependency graphs retain explicit unchecked state.
			var current httpapi.Profile
			if err := s.TenantGet(owner.id, "profiles", "p", &current); err != nil {
				t.Fatal(err)
			}
			current.SourceIDs = []string{"unread-source"}
			if err := s.TenantPut(owner.id, "profiles", "p", current); err != nil {
				t.Fatal(err)
			}
			check(false, true)
			var after httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "o", &after); err != nil || !reflect.DeepEqual(published, after) {
				t.Fatal("publication modified", err)
			}
			code, v, raw := req(t, other.c, "GET", srv.URL+"/api/me/actions", "", nil)
			if code != 200 || len(v["items"].([]any)) != 0 {
				t.Fatal(raw)
			}
		})
	}
}

func TestActionsCompareManagedPlatformRequiresCompleteLiveProof(t *testing.T) {
	f := newMixedRotationRecoveryFixture(t)
	f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "managed-action", "name": "Managed", "profileId": "rotation-profile", "mode": "nodes-only"}, 201)
	check := func(changed, unchecked bool) {
		t.Helper()
		v := f.ownerRequest("GET", "/me/actions", nil, 200)
		if v["partial"] != unchecked || (len(v["uncheckedOutputs"].([]any)) == 1) != unchecked || (len(v["items"].([]any)) == 1) != changed {
			t.Fatalf("unexpected action state partial=%v items=%d unchecked=%d", v["partial"], len(v["items"].([]any)), len(v["uncheckedOutputs"].([]any)))
		}
	}
	check(false, false)
	f.rotate("credential-v2")
	check(false, true)
	f.queue("actions-new-proof")
	f.observe(0, false)
	check(false, true)
	f.observe(1, false)
	check(true, false)
	var enrollment httpapi.Enrollment
	if err := f.s.Get("instance-enrollments", f.scopes[1].InstanceID, &enrollment); err != nil {
		t.Fatal(err)
	}
	enrollment.Revoked = true
	if err := f.s.Put("instance-enrollments", f.scopes[1].InstanceID, enrollment); err != nil {
		t.Fatal(err)
	}
	check(false, true)
	enrollment.Revoked = false
	if err := f.s.Put("instance-enrollments", f.scopes[1].InstanceID, enrollment); err != nil {
		t.Fatal(err)
	}
	check(true, false)
	var grant httpapi.PublicEntryGrant
	if err := f.s.TenantGet(f.owner.id, "platform-entries", "rotation-grant", &grant); err != nil {
		t.Fatal(err)
	}
	grant.PublishedRouteID = "other-path"
	if err := f.s.TenantPut(f.owner.id, "platform-entries", "rotation-grant", grant); err != nil {
		t.Fatal(err)
	}
	check(false, true)
	grant.PublishedRouteID = grant.RouteID
	grant.ID = "different-entry"
	if err := f.s.TenantPut(f.owner.id, "platform-entries", "rotation-grant", grant); err != nil {
		t.Fatal(err)
	}
	check(false, true)
}
