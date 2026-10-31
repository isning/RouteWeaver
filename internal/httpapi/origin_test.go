package httpapi_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestConfiguredHTTPSOriginBehindLoopbackProxy(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{31}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.EnsureAdmin("operator", "synthetic-password-only"); err != nil {
		t.Fatal(err)
	}
	h := httpapi.NewWithOptions(s, render.Default(), httpapi.Options{PublicOrigin: "https://cp.example"})
	request := func(origin, host string, duplicate bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/auth/login", strings.NewReader(`{"username":"operator","password":"synthetic-password-only"}`))
		r.Host = host
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		if duplicate {
			r.Header.Add("Origin", "https://cp.example")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	good := request("https://cp.example", "cp.example", false)
	if good.Code != 200 {
		t.Fatalf("proxy HTTPS origin rejected: %d %s", good.Code, good.Body.String())
	}
	cookies := good.Result().Cookies()
	if len(cookies) == 0 || !cookies[0].Secure || !cookies[0].HttpOnly {
		t.Fatal("public HTTPS cookie lost security attributes")
	}
	for _, bad := range []struct {
		origin, host string
		duplicate    bool
	}{
		{"https://evil.example", "cp.example", false}, {"http://cp.example", "cp.example", false}, {"https://cp.example", "evil.example", false}, {"https://cp.example/path", "cp.example", false}, {"https://cp.example", "cp.example", true},
	} {
		if got := request(bad.origin, bad.host, bad.duplicate); got.Code != 403 {
			t.Fatalf("invalid proxy origin accepted: %+v status%d", bad, got.Code)
		}
	}
}

func TestPublicOriginConfigurationIsAnHTTPSOriginOnly(t *testing.T) {
	for _, raw := range []string{"http://cp.example", "https://user:pass@cp.example", "https://cp.example/path", "https://cp.example?token=x", "https://cp.example#fragment", "https://cp.example:99999", "https://cp.example,https://evil.example", "https://:443", "https://cp.example:", "https://*"} {
		if _, err := httpapi.CanonicalPublicOrigin(raw); err == nil {
			t.Fatalf("invalid public origin accepted: %s", raw)
		}
	}
	if got, err := httpapi.CanonicalPublicOrigin("https://CP.EXAMPLE:443/"); err != nil || got != "https://cp.example" {
		t.Fatalf("canonical origin %q %v", got, err)
	}
}
