package httpapi_test

import (
	"net/http"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestCollectionDeleteDependenciesAndOwnerBoundaryAtHTTPSeam(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collectionowner")
	other := inviteClient(t, s, srv, "collectionother")
	endpoint := srv.URL + "/api/me/collections/shared"
	source := map[string]any{"id": "retained-source", "name": "Retained source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-password@127.0.0.1:1080#Fixture", "enabled": true}
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, source)
	if code != 200 {
		t.Fatalf("create source: %d %s", code, raw)
	}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/collections", owner.csrf, map[string]any{"id": "shared", "name": "Owned collection", "sources": []any{map[string]any{"sourceId": "retained-source", "steps": []any{}}}, "steps": []any{}})
	if code != 200 {
		t.Fatalf("create collection: %d %s", code, raw)
	}
	code, preview, raw := req(t, owner.c, "GET", endpoint+"/dependencies", "", nil)
	if code != 200 || preview["deletable"] != true {
		t.Fatalf("initial dependency preview: %d %s", code, raw)
	}
	for _, check := range []struct {
		client sessionClient
		status int
	}{{other, 404}, {sessionClient{c: http.DefaultClient}, 401}} {
		code, _, raw = req(t, check.client.c, "GET", endpoint+"/dependencies", "", nil)
		if code != check.status {
			t.Fatalf("dependency ownership: %d %s", code, raw)
		}
		if strings.Contains(raw, "Owned collection") {
			t.Fatal("foreign collection disclosure")
		}
	}
	for _, id := range []string{"first", "second"} {
		profile := map[string]any{"id": id, "name": "Dependent " + id, "collectionId": "shared", "target": map[string]string{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "defaultAction": map[string]string{"kind": "direct"}, "runtime": map[string]any{"mixedPort": 7890}}}
		code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile)
		if code != 200 {
			t.Fatalf("create dependent: %d %s", code, raw)
		}
	}
	code, preview, raw = req(t, owner.c, "GET", endpoint+"/dependencies", "", nil)
	if code != 200 || preview["deletable"] != false {
		t.Fatalf("referenced preview: %d %s", code, raw)
	}
	profiles, ok := preview["profiles"].([]any)
	if !ok || len(profiles) != 2 || !strings.Contains(raw, "Dependent first") || !strings.Contains(raw, "Dependent second") {
		t.Fatalf("all named dependencies: %s", raw)
	}
	// A previously clear preview never grants permission to delete newly referenced data.
	code, _, raw = req(t, owner.c, "DELETE", endpoint, owner.csrf, nil)
	if code != 409 || !strings.Contains(raw, "Dependent first") || !strings.Contains(raw, "Dependent second") {
		t.Fatalf("delete must name all blockers: %d %s", code, raw)
	}
	for _, id := range []string{"first", "second"} {
		code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/profiles/"+id, "", nil)
		if code != 200 {
			t.Fatalf("dependent must remain: %d %s", code, raw)
		}
		code, _, raw = req(t, owner.c, "DELETE", srv.URL+"/api/me/profiles/"+id, owner.csrf, nil)
		if code != 200 {
			t.Fatalf("remove profile: %d %s", code, raw)
		}
	}
	code, _, raw = req(t, owner.c, "DELETE", endpoint, "", nil)
	if code != 403 {
		t.Fatalf("CSRF required: %d %s", code, raw)
	}
	code, _, raw = req(t, other.c, "DELETE", endpoint, other.csrf, nil)
	if code == 200 || strings.Contains(raw, "Owned collection") {
		t.Fatalf("foreign deletion: %d %s", code, raw)
	}
	code, _, raw = req(t, owner.c, "DELETE", endpoint, owner.csrf, nil)
	if code != 200 {
		t.Fatalf("unreferenced deletion: %d %s", code, raw)
	}
	code, _, raw = req(t, owner.c, "GET", endpoint, "", nil)
	if code != 404 {
		t.Fatalf("deleted collection remains: %d %s", code, raw)
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/sources/retained-source", "", nil)
	if code != 200 {
		t.Fatalf("collection deletion must preserve source: %d %s", code, raw)
	}

}
