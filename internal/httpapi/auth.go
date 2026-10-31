package httpapi

import (
	"net/http"
	"routeweaver/internal/store"
	"time"
)

func publicAccount(a store.Account) map[string]any {
	return map[string]any{"id": a.ID, "name": a.Name, "username": a.Username, "role": a.Role, "mfaEnabled": a.TOTPSecret != ""}
}
func (h *server) establish(w http.ResponseWriter, a store.Account) {
	s, token, e := h.s.NewSession(a, time.Now())
	if e != nil {
		fail(w, 500, "cannot create session")
		return
	}
	h.sessionResponse(w, a, s, token)
}
func (h *server) sessionResponse(w http.ResponseWriter, a store.Account, s store.Session, token string) {
	http.SetCookie(w, &http.Cookie{Name: "routeweaver_session", Value: token, Path: "/", HttpOnly: true, Secure: h.opts.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: 12 * 3600})
	writeJSON(w, 200, map[string]any{"user": publicAccount(a), "csrfToken": s.CSRFToken})
}
func (h *server) login(w http.ResponseWriter, r *http.Request) {
	if !h.allowLogin(r) {
		fail(w, 429, "too many login attempts; retry later")
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TOTP     string `json:"totp"`
	}
	if !decode(w, r, &in) {
		return
	}
	a, session, token, e := h.s.Login(in.Username, in.Password, in.TOTP, time.Now())
	if e != nil {
		fail(w, 401, "invalid credentials")
		return
	}
	h.sessionResponse(w, a, session, token)
}
func (h *server) acceptInvite(w http.ResponseWriter, r *http.Request) {
	if !h.allowLogin(r) {
		fail(w, 429, "too many attempts; retry later")
		return
	}
	var in struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	a, e := h.s.AcceptInvite(in.Token, in.Username, in.Password)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	h.establish(w, a)
}
func (h *server) me(w http.ResponseWriter, r *http.Request) {
	p := current(r)
	writeJSON(w, 200, map[string]any{"user": publicAccount(p.Account), "csrfToken": p.Session.CSRFToken})
}
func (h *server) logout(w http.ResponseWriter, r *http.Request) {
	p := current(r)
	var revokeErr error
	if !p.Bearer {
		revokeErr = h.s.Remove("sessions", p.Session.Digest)
	}
	http.SetCookie(w, &http.Cookie{Name: "routeweaver_session", Value: "", Path: "/", HttpOnly: true, Secure: h.opts.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	if revokeErr != nil && revokeErr != store.ErrNotFound {
		fail(w, 500, "browser cookie cleared, but server session could not be revoked; retry logout")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (h *server) setupMFA(w http.ResponseWriter, r *http.Request) {
	p := current(r)
	if p.Bearer || p.Account.Role != "admin" {
		fail(w, 403, "local administrator session required")
		return
	}
	if !h.allowLogin(r) {
		fail(w, 429, "too many MFA attempts; retry later")
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	secret, uri, e := h.s.BeginMFA(p.Account.ID, in.Password, time.Now())
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"secret": secret, "uri": uri})
}
func (h *server) enableMFA(w http.ResponseWriter, r *http.Request) {
	p := current(r)
	if p.Bearer || p.Account.Role != "admin" {
		fail(w, 403, "local administrator session required")
		return
	}
	if !h.allowLogin(r) {
		fail(w, 429, "too many MFA attempts; retry later")
		return
	}
	var in struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &in) {
		return
	}
	a, session, token, e := h.s.EnableMFA(p.Account.ID, in.Code, time.Now())
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	h.s.Audit(p.Account.ID, "mfa.enabled", p.Account.ID)
	h.sessionResponse(w, a, session, token)
}
