package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"routeweaver/internal/auth"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

// Seed only the transient clock state: expiration cannot be driven over HTTP
// without a five-minute sleep. Assertions still use the public HTTP boundary.
func TestOIDCExpiredBrowserTransactionsFailClosed(t *testing.T) {
	p := &OIDCProvider{origin: "https://routeweaver.example", flows: map[string]oidcFlow{}}
	h := NewWithOptions(nil, render.Default(), Options{PublicOrigin: p.origin, OIDC: p})
	for _, phase := range []string{"callback", "complete"} {
		t.Run(phase, func(t *testing.T) {
			cookie := "expired-fixture-binding"
			key := auth.Digest(cookie)
			f := oidcFlow{binding: key, expires: time.Now().Add(-time.Second)}
			path := "/api/auth/oidc/complete"
			method := "POST"
			if phase == "callback" {
				key = auth.Digest("fixture-state")
				path = "/api/auth/oidc/callback?state=fixture-state&code=fixture-code"
				method = "GET"
			} else {
				f.account = &store.Account{ID: "must-not-login"}
			}
			p.flows[key] = f
			r := httptest.NewRequest(method, p.origin+path, bytes.NewBufferString("{}"))
			r.Header.Set("Origin", p.origin)
			r.AddCookie(&http.Cookie{Name: oidcCookie, Value: cookie})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if phase == "callback" {
				if w.Code != 303 || w.Header().Get("Location") != "/?oidc=error" {
					t.Fatalf("expired callback: %d", w.Code)
				}
			} else if w.Code != 401 {
				t.Fatalf("expired completion: %d", w.Code)
			}
			for _, c := range w.Result().Cookies() {
				if c.Name == "routeweaver_session" {
					t.Fatal("expired transaction issued session")
				}
			}
			if _, ok := p.flows[key]; ok {
				t.Fatal("expired proof not consumed")
			}
		})
	}
}
