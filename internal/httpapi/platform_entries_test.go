package httpapi_test

import (
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestEntryAdministrationDoesNotReviveRetiredFeedCredentials(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "entry-owner")
	other := inviteClient(t, s, srv, "entry-other")
	admin := operatorClient()
	if err := s.Put("routes", "r", domain.Route{ID: "r", Name: "Entitled route", UserIDs: []string{user.id}}); err != nil {
		t.Fatal(err)
	}
	grant := httpapi.PublicEntryGrant{ID: "entry", Name: "User entry", RouteID: "r", CredentialVersion: "v1", Connection: domain.Connection{Host: "127.0.0.1", Port: 1080, Protocol: "socks", Username: "synthetic-user", Password: "synthetic-entry-secret"}}
	path := srv.URL + "/api/users/" + user.id + "/entries"
	if code, _, raw := req(t, admin, "POST", path, "", grant); code != 201 {
		t.Fatalf("grant %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "GET", path, "", nil); code != 200 || strings.Contains(raw, "synthetic-entry-secret") {
		t.Fatalf("summary %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "GET", path+"/entry/reveal", "", nil); code != 200 || !strings.Contains(raw, "synthetic-entry-secret") {
		t.Fatalf("reveal %d %s", code, raw)
	}
	if code, _, raw := req(t, other.c, "GET", path+"/entry/reveal", "", nil); code != 403 {
		t.Fatalf("unauthorized reveal %d %s", code, raw)
	}
	profile := httpapi.Profile{ID: "p", Name: "Platform profile", Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, PlatformEntryIDs: []string{"entry"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "entry"}}}
	if code, _, raw := req(t, user.c, "POST", srv.URL+"/api/me/profiles", user.csrf, profile); code != 200 {
		t.Fatalf("profile %d %s", code, raw)
	}
	code, out, raw := req(t, user.c, "POST", srv.URL+"/api/me/outputs", user.csrf, map[string]string{"id": "o", "name": "Feed", "profileId": "p"})
	if code != 201 {
		t.Fatalf("output %d %s", code, raw)
	}
	feed := srv.URL + out["feedPath"].(string)
	if code, _, raw = req(t, http.DefaultClient, "GET", feed, "", nil); code != 200 {
		t.Fatalf("feed %d %s", code, raw)
	}
	if code, _, raw = req(t, admin, "DELETE", path+"/entry", "", nil); code != 200 {
		t.Fatalf("revoke %d %s", code, raw)
	}
	if code, _, raw = req(t, http.DefaultClient, "GET", feed, "", nil); code == 200 {
		t.Fatalf("revoked credential served %s", raw)
	}
	if code, _, raw = req(t, admin, "POST", path, "", grant); code != 409 {
		t.Fatalf("revoked version reactivated %d %s", code, raw)
	}
	grant.CredentialVersion = "v2"
	if code, _, raw = req(t, admin, "POST", path, "", grant); code != 201 {
		t.Fatalf("new credential %d %s", code, raw)
	}
	if code, _, raw = req(t, http.DefaultClient, "GET", feed, "", nil); code == 200 {
		t.Fatalf("old frozen feed became valid %s", raw)
	}
	grant.CredentialVersion = "v1"
	if code, _, raw = req(t, admin, "POST", path, "", grant); code != 409 {
		t.Fatalf("retired version reused %d %s", code, raw)
	}
}
