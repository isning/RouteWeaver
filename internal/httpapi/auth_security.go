package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/store"
	"time"
)

func (h *server) localSecuritySession(w http.ResponseWriter, r *http.Request) bool {
	if current(r).Bearer {
		fail(w, 403, "local browser session required")
		return false
	}
	return true
}
func securityError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, store.ErrCredentials):
		fail(w, 403, "invalid credentials")
	case errors.Is(e, store.ErrAccountProtected):
		fail(w, 409, "account action is not allowed: self, retired or last administrator account is protected")
	case errors.Is(e, store.ErrConflict):
		fail(w, 409, "security state changed; sign in again and retry")
	case errors.Is(e, store.ErrNotFound):
		fail(w, 404, "not found")
	case errors.Is(e, store.ErrInvalidSecurityAction):
		fail(w, 400, e.Error())
	default:
		fail(w, 500, "security action could not be committed; retry safely")
	}
}
func (h *server) registerAccountSecurity(r chi.Router) {
	r.Post("/auth/password", func(w http.ResponseWriter, r *http.Request) {
		if !h.localSecuritySession(w, r) {
			return
		}
		p := current(r)
		if !h.allowLogin(r) {
			fail(w, 429, "too many security attempts; retry later")
			return
		}
		var in struct {
			CurrentPassword string `json:"currentPassword"`
			NewPassword     string `json:"newPassword"`
			TOTP            string `json:"totp"`
		}
		if !decode(w, r, &in) {
			return
		}
		a, s, token, e := h.s.ChangePassword(p.Account.ID, p.Session.Digest, in.CurrentPassword, in.NewPassword, in.TOTP, time.Now())
		if e != nil {
			securityError(w, e)
			return
		}
		h.sessionResponse(w, a, s, token)
	})
	r.Get("/auth/sessions", func(w http.ResponseWriter, r *http.Request) {
		if !h.localSecuritySession(w, r) {
			return
		}
		p := current(r)
		v, e := h.s.Sessions(p.Account.ID, p.Session.Digest, time.Now())
		if e != nil {
			securityError(w, e)
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/auth/sessions/revoke-others", func(w http.ResponseWriter, r *http.Request) {
		if !h.localSecuritySession(w, r) {
			return
		}
		p := current(r)
		if !h.allowLogin(r) {
			fail(w, 429, "too many security attempts; retry later")
			return
		}
		var in struct {
			CurrentPassword string `json:"currentPassword"`
			TOTP            string `json:"totp"`
		}
		if !decode(w, r, &in) {
			return
		}
		if e := h.s.RevokeOtherSessions(p.Account.ID, p.Session.Digest, in.CurrentPassword, in.TOTP, time.Now()); e != nil {
			securityError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	r.Delete("/auth/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !h.localSecuritySession(w, r) {
			return
		}
		p := current(r)
		own, e := h.s.RevokeSession(p.Account.ID, p.Session.Digest, chi.URLParam(r, "id"), time.Now())
		if e != nil {
			securityError(w, e)
			return
		}
		if own {
			http.SetCookie(w, &http.Cookie{Name: "routeweaver_session", Value: "", Path: "/", HttpOnly: true, Secure: h.opts.SecureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		}
		writeJSON(w, 200, map[string]bool{"ok": true, "current": own})
	})
	r.Group(func(r chi.Router) {
		r.Use(requireAdmin)
		r.Get("/admin/accounts", func(w http.ResponseWriter, r *http.Request) {
			if !h.localSecuritySession(w, r) {
				return
			}
			all, e := h.s.List("accounts")
			if e != nil {
				fail(w, 500, "cannot list accounts")
				return
			}
			out := []map[string]any{}
			for _, raw := range all {
				var a store.Account
				if json.Unmarshal(raw, &a) != nil {
					fail(w, 500, "cannot read accounts")
					return
				}
				out = append(out, publicAccount(a))
			}
			writeJSON(w, 200, out)
		})
		r.Post("/admin/accounts/{id}/security", func(w http.ResponseWriter, r *http.Request) {
			if !h.localSecuritySession(w, r) {
				return
			}
			p := current(r)
			if !h.allowLogin(r) {
				fail(w, 429, "too many security attempts; retry later")
				return
			}
			var in store.SecurityAction
			if !decode(w, r, &in) {
				return
			}
			a, e := h.s.AccountSecurity(p.Account.ID, p.Session.Digest, chi.URLParam(r, "id"), in, time.Now())
			if e != nil {
				securityError(w, e)
				return
			}
			writeJSON(w, 200, publicAccount(a))
		})
	})
}
