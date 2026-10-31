package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func securityLogin(t *testing.T, srv *httptest.Server, name, password string) sessionClient {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	code, v, raw := req(t, c, "POST", srv.URL+"/api/auth/login", "", map[string]string{"username": name, "password": password})
	if code != 200 {
		t.Fatalf("login %d %s", code, raw)
	}
	return sessionClient{c, v["csrfToken"].(string), v["user"].(map[string]any)["id"].(string)}
}
func securitySessions(t *testing.T, srv *httptest.Server, u sessionClient) []store.SessionView {
	t.Helper()
	code, _, raw := req(t, u.c, "GET", srv.URL+"/api/auth/sessions", "", nil)
	if code != 200 {
		t.Fatalf("sessions %d %s", code, raw)
	}
	var v []store.SessionView
	if e := json.Unmarshal([]byte(raw), &v); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(raw, "digest") || strings.Contains(raw, "csrfToken") || strings.Contains(raw, "accountId") {
		t.Fatal("session secrets exposed")
	}
	return v
}
func TestAccountSecurityHTTPRotationCSRFAndOwnership(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "security-http")
	other := inviteClient(t, s, srv, "unrelated-http")
	old := securityLogin(t, srv, "security-http", "synthetic-test-password")
	entries := securitySessions(t, srv, u)
	if len(entries) != 2 {
		t.Fatal(entries)
	}
	otherEntries := securitySessions(t, srv, other)
	code, _, raw := req(t, u.c, "DELETE", srv.URL+"/api/auth/sessions/"+otherEntries[0].ID, u.csrf, nil)
	if code != 404 {
		t.Fatalf("cross-owner revoke %d %s", code, raw)
	}
	payload := map[string]string{"currentPassword": "synthetic-test-password", "newPassword": "synthetic-changed-password"}
	code, _, _ = req(t, u.c, "POST", srv.URL+"/api/auth/password", "", payload)
	if code != 403 {
		t.Fatalf("missing CSRF accepted: %d", code)
	}
	payload["currentPassword"] = "wrong-password"
	code, _, _ = req(t, u.c, "POST", srv.URL+"/api/auth/password", u.csrf, payload)
	if code != 403 {
		t.Fatalf("wrong password %d", code)
	}
	payload["currentPassword"] = "synthetic-test-password"
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/auth/password", u.csrf, payload)
	if code != 200 {
		t.Fatalf("change %d %s", code, raw)
	}
	rotated := out["csrfToken"].(string)
	if rotated == u.csrf {
		t.Fatal("CSRF not rotated")
	}
	if code, _, _ = req(t, old.c, "GET", srv.URL+"/api/auth/me", "", nil); code != 401 {
		t.Fatalf("old session survived: %d", code)
	}
	if code, _, _ = req(t, u.c, "POST", srv.URL+"/api/auth/logout", u.csrf, nil); code != 403 {
		t.Fatal("old CSRF accepted")
	}
	u.csrf = rotated
	entries = securitySessions(t, srv, u)
	if len(entries) != 1 || !entries[0].Current {
		t.Fatal(entries)
	}
	code, out, raw = req(t, u.c, "DELETE", srv.URL+"/api/auth/sessions/"+entries[0].ID, u.csrf, nil)
	if code != 200 || out["current"] != true {
		t.Fatalf("own revoke %d %s", code, raw)
	}
	if code, _, _ = req(t, u.c, "GET", srv.URL+"/api/auth/me", "", nil); code != 401 {
		t.Fatal("current session not revoked")
	}
	if code, _, _ = req(t, other.c, "GET", srv.URL+"/api/auth/me", "", nil); code != 200 {
		t.Fatal("other account affected")
	}
}
func TestAdminAccountDisableResetAndRetirementHTTP(t *testing.T) {
	var code int
	s, srv := makeServer(t)
	if e := s.EnsureAdmin("security-admin", "synthetic-admin-password"); e != nil {
		t.Fatal(e)
	}
	admin := securityLogin(t, srv, "security-admin", "synthetic-admin-password")
	u := inviteClient(t, s, srv, "managed-account")
	profile := templateTestProfile("account-feed", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	if status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, profile); status != 200 {
		t.Fatalf("prepare profile: %d %s", status, raw)
	}
	status, output, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]string{"id": "account-feed", "name": "Account feed", "profileId": profile.ID})
	if status != 201 {
		t.Fatalf("prepare feed: %d %s", status, raw)
	}
	feed := srv.URL + output["feedPath"].(string)
	if status, _, raw := req(t, http.DefaultClient, "GET", feed, "", nil); status != 200 {
		t.Fatalf("initial feed: %d %s", status, raw)
	}

	action := func(target, kind string, more map[string]string) (int, map[string]any, string) {
		in := map[string]string{"action": kind, "currentPassword": "synthetic-admin-password", "reason": "Synthetic security test"}
		for k, v := range more {
			in[k] = v
		}
		return req(t, admin.c, "POST", srv.URL+"/api/admin/accounts/"+target+"/security", admin.csrf, in)
	}
	if code, _, raw := action(admin.id, "disable", nil); code != 409 {
		t.Fatalf("self disable %d %s", code, raw)
	}
	h := httpapi.New(s, render.Default(), validationTestToken, "")
	r := httptest.NewRequest("POST", "/api/admin/accounts/"+u.id+"/security", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+validationTestToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("operator bearer bypassed browser reauthentication")
	}
	if code, _, raw := action(u.id, "disable", nil); code != 200 {
		t.Fatalf("disable %d %s", code, raw)
	}
	if code, _, _ = req(t, u.c, "GET", srv.URL+"/api/auth/me", "", nil); code != 401 {
		t.Fatal("disabled session survived")
	}
	if status, _, raw := req(t, http.DefaultClient, "GET", feed, "", nil); status != 403 {
		t.Fatalf("disabled feed: %d %s", status, raw)
	}
	policy, e := s.EffectivePolicy(u.id, time.Now())
	if e != nil || policy.Status == "active" {
		t.Fatalf("disabled account delivery policy %v %v", policy, e)
	}
	if code, _, raw := action(u.id, "enable", nil); code != 200 {
		t.Fatalf("enable %d %s", code, raw)
	}
	if code, _, raw := action(u.id, "reset-password", map[string]string{"newPassword": "synthetic-temporary-password"}); code != 200 {
		t.Fatalf("reset %d %s", code, raw)
	}
	u = securityLogin(t, srv, "managed-account", "synthetic-temporary-password")
	if code, _, _ = req(t, u.c, "GET", srv.URL+"/api/me/profiles", "", nil); code != 403 {
		t.Fatal("temporary password gained normal access")
	}
	if code, _, raw := req(t, u.c, "POST", srv.URL+"/api/auth/password", u.csrf, map[string]string{"currentPassword": "synthetic-temporary-password", "newPassword": "synthetic-final-password"}); code != 200 {
		t.Fatalf("required password change failed %d %s", code, raw)
	}
	if code, _, _ = req(t, u.c, "GET", srv.URL+"/api/me/profiles", "", nil); code != 200 {
		t.Fatal("password change did not restore access")
	}
	if code, _, raw := action(u.id, "retire", nil); code != 200 {
		t.Fatalf("retire %d %s", code, raw)
	}
	if status, _, raw := req(t, http.DefaultClient, "GET", feed, "", nil); status != 403 {
		t.Fatalf("retired feed: %d %s", status, raw)
	}
	if code, _, _ = action(u.id, "enable", nil); code != 409 {
		t.Fatal("retirement reversed")
	}
	var retained store.Account
	if e = s.Get("accounts", u.id, &retained); e != nil || !retained.Retired {
		t.Fatal("retirement deleted identity")
	}
}
