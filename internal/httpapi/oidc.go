package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"routeweaver/internal/auth"
	"routeweaver/internal/store"
)

// OIDCConfig is operator-owned startup configuration. Subject is the exact
// issuer-scoped opaque identifier, never an email or an identity-provider role.
type OIDCConfig struct {
	Issuer       string        `json:"issuer"`
	ClientID     string        `json:"clientId"`
	ClientSecret string        `json:"clientSecret"`
	Label        string        `json:"label"`
	Bindings     []OIDCBinding `json:"bindings"`
}
type OIDCBinding struct {
	Subject   string `json:"subject"`
	AccountID string `json:"accountId"`
}
type OIDCProvider struct {
	origin   string
	label    string
	issuer   string
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	client   *http.Client
	bindings map[string]string
	mu       sync.Mutex
	flows    map[string]oidcFlow
}
type oidcBoundedTransport struct{ base http.RoundTripper }

func (t oidcBoundedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !oidcHTTPSURL(r.URL.String()) {
		return nil, errors.New("OIDC HTTPS required")
	}
	response, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	response.Body = http.MaxBytesReader(nil, response.Body, 1<<20)
	return response, nil
}

type oidcFlow struct {
	binding  string
	nonce    string
	verifier string
	expires  time.Time
	account  *store.Account
}

const oidcCookie = "__Host-routeweaver_oidc"
const oidcTTL = 5 * time.Minute

// NewOIDCProvider validates explicit configuration and discovery before serving
// traffic. Context may supply a normal-TLS trusted HTTP client for private IdPs.
func NewOIDCProvider(ctx context.Context, config OIDCConfig, publicOrigin string) (*OIDCProvider, error) {
	origin, err := CanonicalPublicOrigin(publicOrigin)
	if err != nil || origin == "" {
		return nil, errors.New("OIDC requires a fixed HTTPS public origin")
	}
	issuerURL, issuerErr := url.Parse(config.Issuer)
	if issuerErr != nil || issuerURL.RawQuery != "" || issuerURL.ForceQuery || !oidcHTTPSURL(config.Issuer) || config.ClientID == "" || config.ClientSecret == "" || len(config.Label) > 80 || len(config.Bindings) == 0 {
		return nil, errors.New("invalid OIDC provider configuration")
	}
	p := &OIDCProvider{origin: origin, label: strings.TrimSpace(config.Label), issuer: config.Issuer, bindings: map[string]string{}, flows: map[string]oidcFlow{}}
	if p.label == "" {
		p.label = "SSO"
	}
	for _, b := range config.Bindings {
		if b.Subject == "" || b.AccountID == "" || p.bindings[b.Subject] != "" {
			return nil, errors.New("invalid or duplicate OIDC subject binding")
		}
		p.bindings[b.Subject] = b.AccountID
	}
	base := http.DefaultClient
	if c, ok := ctx.Value(oauth2.HTTPClient).(*http.Client); ok && c != nil {
		base = c
	}
	client := *base
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error { return errors.New("OIDC redirect rejected") }
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = oidcBoundedTransport{transport}
	p.client = &client
	ctx = oidc.ClientContext(ctx, p.client)
	discovery, err := oidc.NewProvider(ctx, config.Issuer)
	if err != nil {
		return nil, errors.New("OIDC provider discovery failed")
	}
	var metadata struct {
		JWKS string `json:"jwks_uri"`
	}
	if discovery.Claims(&metadata) != nil || !oidcHTTPSURL(metadata.JWKS) || !oidcHTTPSURL(discovery.Endpoint().AuthURL) || !oidcHTTPSURL(discovery.Endpoint().TokenURL) {
		return nil, errors.New("OIDC discovery requires HTTPS endpoints")
	}
	p.oauth = oauth2.Config{ClientID: config.ClientID, ClientSecret: config.ClientSecret, Endpoint: discovery.Endpoint(), RedirectURL: origin + "/api/auth/oidc/callback", Scopes: []string{oidc.ScopeOpenID}}
	p.verifier = discovery.Verifier(&oidc.Config{ClientID: config.ClientID})
	return p, nil
}
func oidcHTTPSURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == "" && u.Opaque == ""
}
func (p *OIDCProvider) put(key string, f oidcFlow) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for k, v := range p.flows {
		if !now.Before(v.expires) {
			delete(p.flows, k)
		}
	}
	if len(p.flows) >= 1024 {
		return false
	}
	p.flows[key] = f
	return true
}
func (p *OIDCProvider) take(key, binding string) (oidcFlow, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, ok := p.flows[key]
	if !ok || subtle.ConstantTimeCompare([]byte(f.binding), []byte(binding)) != 1 {
		return oidcFlow{}, false
	}
	delete(p.flows, key)
	return f, time.Now().Before(f.expires)
}
func (h *server) oidcMetadata(w http.ResponseWriter, r *http.Request) {
	p := h.opts.OIDC
	if p == nil {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": true, "label": p.label})
}
func (h *server) oidcSameOrigin(r *http.Request) bool {
	return h.opts.OIDC != nil && len(r.Header.Values("Origin")) == 1 && r.Header.Get("Origin") == h.opts.OIDC.origin && validMutationOrigin(r, h.opts.OIDC.origin)
}
func oidcSetCookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: oidcCookie, Value: value, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func (h *server) oidcStart(w http.ResponseWriter, r *http.Request) {
	if !h.oidcSameOrigin(r) {
		fail(w, 403, "same-origin login required")
		return
	}
	if !h.allowLogin(r) {
		fail(w, 429, "too many login attempts")
		return
	}
	var input struct{}
	if !decode(w, r, &input) {
		return
	}
	p := h.opts.OIDC
	state, e1 := auth.Token()
	binding, e2 := auth.Token()
	nonce, e3 := auth.Token()
	if e1 != nil || e2 != nil || e3 != nil {
		fail(w, 500, "cannot start login")
		return
	}
	verifier := oauth2.GenerateVerifier()
	if !p.put(auth.Digest(state), oidcFlow{binding: auth.Digest(binding), nonce: nonce, verifier: verifier, expires: time.Now().Add(oidcTTL)}) {
		fail(w, 503, "login temporarily unavailable")
		return
	}
	oidcSetCookie(w, binding, int(oidcTTL.Seconds()))
	writeJSON(w, 200, map[string]string{"authorizationUrl": p.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier))})
}
func (h *server) oidcCallback(w http.ResponseWriter, r *http.Request) {
	p := h.opts.OIDC
	failed := func() { oidcSetCookie(w, "", -1); http.Redirect(w, r, "/?oidc=error", http.StatusSeeOther) }
	if p == nil {
		failed()
		return
	}
	// State/code are single values. Callback accepts no caller-supplied redirect.
	q := r.URL.Query()
	cookie, err := r.Cookie(oidcCookie)
	if err != nil || len(q["state"]) != 1 || len(q["code"]) != 1 || q.Get("error") != "" || q.Get("code") == "" {
		failed()
		return
	}
	f, ok := p.take(auth.Digest(q.Get("state")), auth.Digest(cookie.Value))
	if !ok || f.account != nil {
		failed()
		return
	}
	ctx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), p.client), 10*time.Second)
	defer cancel()
	token, err := p.oauth.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(f.verifier))
	if err != nil {
		failed()
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		failed()
		return
	}
	id, err := p.verifier.Verify(ctx, raw)
	if err != nil || id.Issuer != p.issuer || id.Subject == "" || subtle.ConstantTimeCompare([]byte(id.Nonce), []byte(f.nonce)) != 1 {
		failed()
		return
	}
	var claims struct {
		AZP string `json:"azp"`
	}
	if id.Claims(&claims) != nil || (len(id.Audience) > 1 && claims.AZP != p.oauth.ClientID) || (claims.AZP != "" && claims.AZP != p.oauth.ClientID) {
		failed()
		return
	}
	accountID := p.bindings[id.Subject]
	var a store.Account
	if accountID == "" || h.s.Get("accounts", accountID, &a) != nil || a.Disabled || a.Retired {
		failed()
		return
	}
	pending, err := auth.Token()
	if err != nil {
		failed()
		return
	}
	digest := auth.Digest(pending)
	if !p.put(digest, oidcFlow{binding: digest, expires: time.Now().Add(oidcTTL), account: &a}) {
		failed()
		return
	}
	oidcSetCookie(w, pending, int(oidcTTL.Seconds()))
	state := "complete"
	if a.TOTPSecret != "" {
		state = "mfa"
	}
	http.Redirect(w, r, "/?oidc="+state, http.StatusSeeOther)
}
func (h *server) oidcComplete(w http.ResponseWriter, r *http.Request) {
	if !h.oidcSameOrigin(r) {
		fail(w, 403, "same-origin login required")
		return
	}
	if !h.allowLogin(r) {
		fail(w, 429, "too many login attempts")
		return
	}
	cookie, err := r.Cookie(oidcCookie)
	if err != nil {
		fail(w, 401, "login expired or invalid; sign in again")
		return
	}
	f, ok := h.opts.OIDC.take(auth.Digest(cookie.Value), auth.Digest(cookie.Value))
	oidcSetCookie(w, "", -1)
	if !ok || f.account == nil {
		fail(w, 401, "login expired or invalid; sign in again")
		return
	}
	var in struct {
		TOTP string `json:"totp"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF {
		fail(w, 401, "login expired or invalid; sign in again")
		return
	}
	a, session, token, err := h.s.CompleteOIDCLogin(*f.account, strings.TrimSpace(in.TOTP), time.Now())
	if err != nil {
		fail(w, 401, "login expired or invalid; sign in again")
		return
	}
	h.sessionResponse(w, a, session, token)
}
