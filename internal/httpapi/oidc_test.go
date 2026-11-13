package httpapi_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/pquerna/otp/totp"
	"golang.org/x/oauth2"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

type oidcFixture struct {
	t        *testing.T
	db       *store.Store
	account  store.Account
	app, idp *httptest.Server
	client   *http.Client
	mu       sync.Mutex
	mode     string
	codes    map[string]url.Values
	serial   int
}

func newOIDCFixture(t *testing.T) *oidcFixture {
	t.Helper()
	s, old := makeServer(t)
	old.Close()
	_, invite, e := s.CreateInvite("oidc-user", "user", time.Now().Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	a, e := s.AcceptInvite(invite, "oidc-user", "synthetic-password")
	if e != nil {
		t.Fatal(e)
	}
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	signer, e := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "fixture-key"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	f := &oidcFixture{t: t, db: s, account: a, codes: map[string]url.Values{}}
	f.idp = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": f.idp.URL, "authorization_endpoint": f.idp.URL + "/authorize", "token_endpoint": f.idp.URL + "/token", "jwks_uri": f.idp.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "fixture-key", Algorithm: "RS256", Use: "sig"}}})
		case "/authorize":
			q := r.URL.Query()
			if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("nonce") == "" || q.Get("scope") != "openid" {
				t.Error("missing OIDC/PKCE protections")
				http.Error(w, "invalid", 400)
				return
			}
			f.mu.Lock()
			f.serial++
			code := time.Now().Format("150405.000000000")
			f.codes[code] = q
			f.mu.Unlock()
			target, _ := url.Parse(q.Get("redirect_uri"))
			v := target.Query()
			v.Set("code", code)
			v.Set("state", q.Get("state"))
			target.RawQuery = v.Encode()
			http.Redirect(w, r, target.String(), 302)
		case "/token":
			r.ParseForm()
			f.mu.Lock()
			q, ok := f.codes[r.Form.Get("code")]
			delete(f.codes, r.Form.Get("code"))
			mode := f.mode
			f.mu.Unlock()
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			id, secret, _ := r.BasicAuth()
			if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != q.Get("code_challenge") || id != "fixture-client" || secret != "synthetic-client-secret" || r.Form.Get("redirect_uri") != q.Get("redirect_uri") {
				http.Error(w, "invalid exchange", 400)
				return
			}
			now := time.Now()
			claims := map[string]any{"iss": f.idp.URL, "sub": "mapped-subject", "aud": "fixture-client", "exp": now.Add(time.Minute).Unix(), "iat": now.Unix(), "nonce": q.Get("nonce"), "email": "operator@example.invalid", "role": "admin"}
			switch mode {
			case "issuer":
				claims["iss"] = "https://wrong.invalid"
			case "audience":
				claims["aud"] = "other-client"
			case "expired":
				claims["exp"] = now.Add(-time.Hour).Unix()
			case "nonce":
				claims["nonce"] = "wrong"
			case "unmapped":
				claims["sub"] = "unknown"
			case "azp":
				claims["aud"] = []string{"fixture-client", "other-client"}
				claims["azp"] = "other-client"
			}
			b, _ := json.Marshal(claims)
			signed, _ := signer.Sign(b)
			raw, _ := signed.CompactSerialize()
			if mode == "signature" {
				parts := strings.Split(raw, ".")
				parts[2] = base64.RawURLEncoding.EncodeToString([]byte("invalid-signature"))
				raw = strings.Join(parts, ".")
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"access_token": "not-stored", "token_type": "Bearer", "id_token": raw})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.idp.Close)
	f.app = httptest.NewUnstartedServer(nil)
	f.app.StartTLS()
	t.Cleanup(f.app.Close)
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, f.idp.Client())
	provider, e := httpapi.NewOIDCProvider(ctx, httpapi.OIDCConfig{Issuer: f.idp.URL, ClientID: "fixture-client", ClientSecret: "synthetic-client-secret", Label: "Fixture SSO", Bindings: []httpapi.OIDCBinding{{Subject: "mapped-subject", AccountID: a.ID}}}, f.app.URL)
	if e != nil {
		t.Fatal(e)
	}
	f.app.Config.Handler = httpapi.NewWithOptions(s, render.Default(), httpapi.Options{PublicOrigin: f.app.URL, OIDC: provider})
	f.client = f.newClient()
	return f
}
func (f *oidcFixture) newClient() *http.Client {
	c := *f.app.Client()
	c.Jar, _ = cookiejar.New(nil)
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}
func (f *oidcFixture) request(c *http.Client, method, path, origin string, body any) *http.Response {
	f.t.Helper()
	var b io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		b = bytes.NewReader(raw)
	}
	r, _ := http.NewRequest(method, path, b)
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	response, e := c.Do(r)
	if e != nil {
		f.t.Fatal(e)
	}
	f.t.Cleanup(func() { response.Body.Close() })
	return response
}
func (f *oidcFixture) start(c *http.Client) string {
	f.t.Helper()
	r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/start", f.app.URL, map[string]any{})
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		f.t.Fatalf("start %d %s", r.StatusCode, b)
	}
	var out map[string]string
	json.NewDecoder(r.Body).Decode(&out)
	return out["authorizationUrl"]
}
func (f *oidcFixture) callback(c *http.Client) string {
	f.t.Helper()
	r := f.request(c, "GET", f.start(c), "", nil)
	if r.StatusCode != 302 {
		f.t.Fatalf("authorize %d", r.StatusCode)
	}
	return r.Header.Get("Location")
}
func (f *oidcFixture) loginCallback(c *http.Client) string {
	r := f.request(c, "GET", f.callback(c), "", nil)
	return r.Header.Get("Location")
}
func TestOIDCHTTPMappedLoginAndFailureBoundaries(t *testing.T) {
	f := newOIDCFixture(t)
	r := f.request(f.client, "GET", f.app.URL+"/api/auth/oidc", "", nil)
	var metadata map[string]any
	json.NewDecoder(r.Body).Decode(&metadata)
	if metadata["enabled"] != true || metadata["label"] != "Fixture SSO" {
		t.Fatal(metadata)
	}
	for _, origin := range []string{"", "https://evil.invalid"} {
		if r := f.request(f.client, "POST", f.app.URL+"/api/auth/oidc/start", origin, map[string]any{}); r.StatusCode != 403 {
			t.Fatal("cross-origin login start accepted")
		}
	}
	for _, mode := range []string{"issuer", "audience", "expired", "nonce", "signature", "unmapped", "azp"} {
		t.Run(mode, func(t *testing.T) {
			f.mu.Lock()
			f.mode = mode
			f.mu.Unlock()
			c := f.newClient()
			if got := f.loginCallback(c); got != "/?oidc=error" {
				t.Fatalf("invalid identity accepted: %s", got)
			}
			if r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]any{}); r.StatusCode != 401 {
				t.Fatalf("failed identity completed: %d", r.StatusCode)
			}
		})
	}
	f.mu.Lock()
	f.mode = ""
	f.mu.Unlock()
	c := f.newClient()
	callback := f.callback(c)
	// A callback stolen by a different browser cannot create a completion proof.
	if r := f.request(f.newClient(), "GET", callback, "", nil); r.Header.Get("Location") != "/?oidc=error" {
		t.Fatal("unbound callback accepted")
	}
	u, _ := url.Parse(callback)
	q := u.Query()
	q.Set("state", "wrong")
	u.RawQuery = q.Encode()
	if r := f.request(f.newClient(), "GET", u.String(), "", nil); r.Header.Get("Location") != "/?oidc=error" {
		t.Fatal("wrong state accepted")
	}
	if r := f.request(c, "GET", callback, "", nil); r.Header.Get("Location") != "/?oidc=complete" {
		t.Fatal("valid callback failed")
	}
	// Callback alone is not a session.
	if r := f.request(c, "GET", f.app.URL+"/api/auth/me", "", nil); r.StatusCode != 401 {
		t.Fatal("callback bypassed finish")
	}
	if r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", "", map[string]any{}); r.StatusCode != 403 {
		t.Fatal("complete omitted origin accepted")
	}
	r = f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]any{})
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("complete %d %s", r.StatusCode, b)
	}
	var session map[string]any
	json.NewDecoder(r.Body).Decode(&session)
	if session["user"].(map[string]any)["role"] != "user" {
		t.Fatal("IdP elevated account role")
	}
	for _, cookie := range r.Cookies() {
		if cookie.Name == "routeweaver_session" && (!cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode) {
			t.Fatal("session security downgraded")
		}
	}
	if r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]any{}); r.StatusCode != 401 {
		t.Fatal("completion replay")
	}
	if r := f.request(c, "GET", callback, "", nil); r.Header.Get("Location") != "/?oidc=error" {
		t.Fatal("callback replay")
	}
}
func TestOIDCHTTPMFAAndAccountChanges(t *testing.T) {
	f := newOIDCFixture(t)
	a := f.account
	a.TOTPSecret = "JBSWY3DPEHPK3PXP"
	if e := f.db.Put("accounts", a.ID, a); e != nil {
		t.Fatal(e)
	}
	wrong := f.newClient()
	if got := f.loginCallback(wrong); got != "/?oidc=mfa" {
		t.Fatal(got)
	}
	if r := f.request(wrong, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]string{"totp": "invalid"}); r.StatusCode != 401 {
		t.Fatal("wrong MFA accepted")
	}
	code, _ := totp.GenerateCode(a.TOTPSecret, time.Now())
	if r := f.request(wrong, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]string{"totp": code}); r.StatusCode != 401 {
		t.Fatal("failed MFA proof reusable")
	}
	one, two := f.newClient(), f.newClient()
	if f.loginCallback(one) != "/?oidc=mfa" || f.loginCallback(two) != "/?oidc=mfa" {
		t.Fatal("MFA missing")
	}
	results := make(chan int, 2)
	for _, c := range []*http.Client{one, two} {
		go func(c *http.Client) {
			r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]string{"totp": code})
			results <- r.StatusCode
		}(c)
	}
	x, y := <-results, <-results
	if !((x == 200 && y == 401) || (x == 401 && y == 200)) {
		t.Fatalf("TOTP replay race: %d %d", x, y)
	}
	// Snapshot invalidation also covers disable/delete/password/MFA mutations.
	for _, change := range []string{"disabled", "retired", "deleted", "password"} {
		t.Run(change, func(t *testing.T) {
			base := f.account
			if e := f.db.Put("accounts", base.ID, base); e != nil {
				t.Fatal(e)
			}
			c := f.newClient()
			if f.loginCallback(c) != "/?oidc=complete" {
				t.Fatal("callback failed")
			}
			switch change {
			case "disabled":
				base.Disabled = true
			case "retired":
				base.Retired = true
			case "password":
				base.PasswordChangeRequired = true
			}
			if change == "deleted" {
				f.db.Remove("accounts", base.ID)
			} else {
				f.db.Put("accounts", base.ID, base)
			}
			if r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]any{}); r.StatusCode != 401 {
				t.Fatalf("account change ignored: %d", r.StatusCode)
			}
		})
	}
	base := f.account
	base.PasswordChangeRequired = true
	f.db.Put("accounts", base.ID, base)
	c := f.newClient()
	if f.loginCallback(c) != "/?oidc=complete" {
		t.Fatal("reset-required callback failed")
	}
	if r := f.request(c, "POST", f.app.URL+"/api/auth/oidc/complete", f.app.URL, map[string]any{}); r.StatusCode != 200 {
		t.Fatal("restricted session unavailable")
	}
	if r := f.request(c, "GET", f.app.URL+"/api/me/overview", "", nil); r.StatusCode != 403 {
		t.Fatal("password reset bypassed")
	}
}

func TestOIDCWhitespaceProviderLabelDefaultsToVisibleSSO(t *testing.T) {
	f := newOIDCFixture(t)
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, f.idp.Client())
	provider, err := httpapi.NewOIDCProvider(ctx, httpapi.OIDCConfig{Issuer: f.idp.URL, ClientID: "fixture-client", ClientSecret: "synthetic-client-secret", Label: " \t ", Bindings: []httpapi.OIDCBinding{{Subject: "mapped-subject", AccountID: f.account.ID}}}, f.app.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewWithOptions(f.db, render.Default(), httpapi.Options{PublicOrigin: f.app.URL, OIDC: provider})
	r := httptest.NewRequest("GET", f.app.URL+"/api/auth/oidc", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var metadata map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || metadata["enabled"] != true || metadata["label"] != "SSO" {
		t.Fatalf("whitespace label disabled visible login: %s", w.Body.String())
	}
}
