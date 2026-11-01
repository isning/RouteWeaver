package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

type sessionClient struct {
	c    *http.Client
	csrf string
	id   string
}

func makeServer(t *testing.T) (*store.Store, *httptest.Server) {
	t.Helper()
	return makeServerAt(t, filepath.Join(t.TempDir(), "db"))
}
func makeServerAt(t *testing.T, databasePath string) (*store.Store, *httptest.Server) {
	t.Helper()
	s, e := store.Open(databasePath, bytes.Repeat([]byte{11}, 32))
	if e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewServer(httpapi.New(s, render.Default(), "012345678901234567890123456789012345", ""))
	t.Cleanup(func() { srv.Close(); s.Close() })
	return s, srv
}
func req(t *testing.T, c *http.Client, method, url, csrf string, v any) (int, map[string]any, string) {
	t.Helper()
	var body io.Reader
	if v != nil {
		b, _ := json.Marshal(v)
		body = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, url, body)
	r.Header.Set("Content-Type", "application/json")
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	res, e := c.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var out map[string]any
	json.Unmarshal(b, &out)
	return res.StatusCode, out, string(b)
}
func inviteClient(t *testing.T, s *store.Store, srv *httptest.Server, name string) sessionClient {
	t.Helper()
	_, token, e := s.CreateInvite(name, "user", time.Now().Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	status, v, raw := req(t, c, "POST", srv.URL+"/api/auth/accept-invite", "", map[string]string{"token": token, "username": name, "password": "synthetic-test-password"})
	if status != 200 {
		t.Fatalf("signup: %d %s", status, raw)
	}
	return sessionClient{c: c, csrf: v["csrfToken"].(string), id: v["user"].(map[string]any)["id"].(string)}
}
func TestTenantIsolationAndCSRFAtHTTPSeam(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "alice")
	b := inviteClient(t, s, srv, "bob")
	source := map[string]any{"id": "source1", "name": "Private source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-password@127.0.0.1:1080#Fixture", "enabled": true}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", "", source)
	if status != 403 {
		t.Fatalf("CSRF: %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	if status != 200 {
		t.Fatalf("source: %d %s", status, raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/sources/source1", "", nil)
	if status != 404 || strings.Contains(raw, "fixture-password") {
		t.Fatalf("IDOR: %d %s", status, raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/state", "", nil)
	if status != 403 {
		t.Fatalf("admin RBAC: %d %s", status, raw)
	}
	source["ownerId"] = a.id
	status, _, raw = req(t, b.c, "POST", srv.URL+"/api/me/sources", b.csrf, source)
	if status != 403 {
		t.Fatalf("owner spoofing: %d %s", status, raw)
	}
}
func TestFeedRotationAndRevocation(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "alice")
	b := inviteClient(t, s, srv, "bob")
	profile := map[string]any{"id": "profile1", "name": "My profile", "target": map[string]string{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "defaultAction": map[string]string{"kind": "direct"}, "endpoints": []any{}, "groups": []any{}, "rules": []any{}, "resources": []any{}, "runtime": map[string]any{"mixedPort": 7890}}}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, profile)
	if status != 200 {
		t.Fatalf("profile: %d %s", status, raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/profiles/profile1", "", nil)
	if status != 404 {
		t.Fatalf("profile IDOR: %d %s", status, raw)
	}
	status, out, raw := req(t, a.c, "POST", srv.URL+"/api/me/outputs", a.csrf, map[string]string{"id": "output1", "name": "My feed", "profileId": "profile1"})
	if status != 201 {
		t.Fatalf("publish: %d %s", status, raw)
	}
	first := out["feedPath"].(string)
	status, _, raw = req(t, http.DefaultClient, "GET", srv.URL+first, "", nil)
	if status != 200 {
		t.Fatalf("feed: %d %s", status, raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/outputs/output1/access", "", nil)
	if status != 404 {
		t.Fatalf("feed access IDOR: %d %s", status, raw)
	}
	status, out, raw = req(t, a.c, "POST", srv.URL+"/api/me/outputs/output1/rotate", a.csrf, map[string]any{})
	if status != 200 {
		t.Fatalf("rotate: %d %s", status, raw)
	}
	second := out["feedPath"].(string)
	status, _, _ = req(t, http.DefaultClient, "GET", srv.URL+first, "", nil)
	if status != 404 {
		t.Fatalf("old token still works: %d", status)
	}
	status, _, _ = req(t, a.c, "POST", srv.URL+"/api/me/outputs/output1/revoke", a.csrf, map[string]any{})
	if status != 200 {
		t.Fatal("revoke failed")
	}
	status, _, _ = req(t, http.DefaultClient, "GET", srv.URL+second, "", nil)
	if status != 404 {
		t.Fatalf("revoked token still works: %d", status)
	}
}

func TestSourceSummariesRedactAndExplicitRevealIsOwnerScoped(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "alice")
	b := inviteClient(t, s, srv, "bob")
	source := map[string]any{"id": "secret-source", "name": "Source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:secret-marker@127.0.0.1:1080#Fixture", "enabled": true}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, a.c, "GET", srv.URL+"/api/me/sources", "", nil)
	if status != 200 || strings.Contains(raw, "secret-marker") {
		t.Fatalf("summary secret leak %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "GET", srv.URL+"/api/me/sources/secret-source/reveal", "", nil)
	if status != 200 || !strings.Contains(raw, "secret-marker") {
		t.Fatalf("owner reveal failed %d %s", status, raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/sources/secret-source/reveal", "", nil)
	if status != 404 || strings.Contains(raw, "secret-marker") {
		t.Fatal("reveal IDOR")
	}
}
