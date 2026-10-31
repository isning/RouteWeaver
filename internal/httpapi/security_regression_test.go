package httpapi_test

import (
	"bytes"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestTrustedProxySeparatesLoginBudgets(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{41}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.EnsureAdmin("proxy-admin", "synthetic-proxy-password"); e != nil {
		t.Fatal(e)
	}
	h := httpapi.NewWithOptions(s, render.Default(), httpapi.Options{TrustedProxyCIDRs: []string{"127.0.0.1/32"}})
	send := func(client, body string) int {
		r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:4567"
		r.Header.Set("X-Forwarded-For", client)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	bad := `{"username":"proxy-admin","password":"wrong-password"}`
	for i := 0; i < 20; i++ {
		if c := send("198.51.100.10", bad); c != 401 {
			t.Fatalf("attempt %d: %d", i, c)
		}
	}
	if c := send("198.51.100.10", bad); c != 429 {
		t.Fatalf("exhausted client: %d", c)
	}
	if c := send("203.0.113.20", `{"username":"proxy-admin","password":"synthetic-proxy-password"}`); c != 200 {
		t.Fatalf("other proxy client blocked: %d", c)
	}
}
func TestUntrustedForwardedAddressCannotEvadeLoginBudget(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{42}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	h := httpapi.NewWithOptions(s, render.Default(), httpapi.Options{})
	for i := 0; i < 21; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{}`))
		r.RemoteAddr = "192.0.2.15:9000"
		r.Header.Set("X-Forwarded-For", []string{"198.51.100.1", "203.0.113.2"}[i%2])
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 401
		if i == 20 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d: %d != %d", i, w.Code, want)
		}
	}
}
func TestProfileSummaryRedactsTransportCredentialsButRevealPreservesThem(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "security-owner")
	p := httpapi.Profile{ID: "secret-path", Name: "Private profile", IR: domain.ClientProfileIR{OwnerID: u.id, Endpoints: []domain.ClientEndpoint{{ID: "private-node", OwnerID: u.id, Name: "Private node", Origin: "imported", Connection: domain.Connection{Host: "example.com", Port: 443, Protocol: "trojan", Password: "synthetic-hidden-password", Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy?token=synthetic-hidden-query"}}}}}}
	if e := s.TenantPut(u.id, "profiles", p.ID, p); e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"/api/me/profiles", "/api/me/profiles/secret-path"} {
		code, _, raw := req(t, u.c, "GET", srv.URL+path, "", nil)
		if code != 200 || strings.Contains(raw, "synthetic-hidden-") {
			t.Fatalf("secret summary leak: %d %s", code, raw)
		}
	}
	code, _, raw := req(t, u.c, "GET", srv.URL+"/api/me/profiles/secret-path/reveal", "", nil)
	if code != 200 || !strings.Contains(raw, "synthetic-hidden-query") || !strings.Contains(raw, "synthetic-hidden-password") {
		t.Fatalf("reveal changed: %d %s", code, raw)
	}
	var stored httpapi.Profile
	if e := s.TenantGet(u.id, "profiles", p.ID, &stored); e != nil || stored.IR.Endpoints[0].Connection.Transport.Path != "/proxy?token=synthetic-hidden-query" {
		t.Fatalf("stored credentials changed: %v", e)
	}
}

func TestProxyChainStopsAtNearestUntrustedHop(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{43}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	h := httpapi.NewWithOptions(s, render.Default(), httpapi.Options{TrustedProxyCIDRs: []string{"127.0.0.1/32", "10.0.0.0/24"}})
	for i := 0; i < 21; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:4567"
		prefix := []string{"198.51.100.1", "203.0.113.2"}[i%2]
		r.Header.Set("X-Forwarded-For", prefix+", 192.0.2.15, 10.0.0.5")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 401
		if i == 20 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("client prefix spoof bypassed nearest untrusted hop: %d", w.Code)
		}
	}
	h = httpapi.NewWithOptions(s, render.Default(), httpapi.Options{TrustedProxyCIDRs: []string{"0.0.0.0/0"}})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{}`)))
	if w.Code != 500 {
		t.Fatal("unsafe proxy config not rejected")
	}
}

func TestAnonymousLoginExhaustionDoesNotBlockAccountSecurity(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "budget-security")
	for i := 0; i < 21; i++ {
		code, _, _ := req(t, u.c, "POST", srv.URL+"/api/auth/login", "", map[string]string{"username": "budget-security", "password": "wrong-password"})
		if i == 20 && code != 429 {
			t.Fatalf("login limiter not exhausted: %d", code)
		}
	}
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/auth/sessions/revoke-others", u.csrf, map[string]string{"currentPassword": "synthetic-test-password"})
	if code != 200 {
		t.Fatalf("anonymous login budget locked out authenticated security: %d %s", code, raw)
	}
}

func TestProfileSaveAndPreviewRedactionPreserveExportCredentials(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "security-render")
	p := templateTestProfile("query-export", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Endpoints[0].Connection = domain.Connection{Host: "example.com", Port: 443, Protocol: "trojan", Password: "synthetic-export-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com"}, Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy?token=synthetic-export-query"}}
	for _, path := range []string{"/api/me/profiles", "/api/me/profiles/preview"} {
		code, _, raw := req(t, u.c, "POST", srv.URL+path, u.csrf, p)
		if code != 200 || strings.Contains(raw, "synthetic-export-") {
			t.Fatalf("save/preview credential leak %s: %d %s", path, code, raw)
		}
	}
	var saved httpapi.Profile
	if e := s.TenantGet(u.id, "profiles", p.ID, &saved); e != nil {
		t.Fatal(e)
	}
	output, e := render.DefaultClients().Render(saved.IR, saved.Target, saved.Mode)
	if e != nil {
		t.Fatal(e)
	}
	if len(output.Artifacts) == 0 || !strings.Contains(output.Artifacts[0].Content, "synthetic-export-password") || !strings.Contains(output.Artifacts[0].Content, "synthetic-export-query") {
		t.Fatal("presentation changed rendered authentication data")
	}
}
