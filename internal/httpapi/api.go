// Package httpapi adapts authenticated admin and tenant operations. All private
// resources derive their owner from the server session, never from request JSON.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"sync"
	"time"
)

type IDInput struct {
	ID string `path:"id"`
}
type StateBody struct {
	store.State
	Capabilities        []domain.Capability `json:"capabilities"`
	DeploymentAvailable bool                `json:"deploymentAvailable"`
}
type StateOutput struct{ Body StateBody }
type MessageOutput struct {
	Body struct {
		OK bool `json:"ok"`
	}
}
type Options struct {
	TrustedProxyCIDRs []string
	PublicOrigin      string
	BackupLimits      backup.Limits
	BackupRestoreDir  string
	BackupRestoreKey  []byte
	AdminToken        string
	UIDir             string
	SecureCookies     bool
}
type server struct {
	trustedProxies           []netip.Prefix
	s                        *store.Store
	registry                 *render.Registry
	opts                     Options
	mu                       sync.Mutex
	attempts                 map[string]attempt
	subscriptionVerification *subscriptionVerification
}
type attempt struct {
	Count int
	Until time.Time
}
type principalKey struct{}
type principal struct {
	Account store.Account
	Session store.Session
	Bearer  bool
}

func current(r *http.Request) principal {
	p, _ := r.Context().Value(principalKey{}).(principal)
	return p
}
func New(s *store.Store, registry *render.Registry, token, uiDir string) http.Handler {
	return NewWithOptions(s, registry, Options{AdminToken: token, UIDir: uiDir})
}
func NewWithOptions(s *store.Store, registry *render.Registry, opts Options) http.Handler {
	return newWithOptions(s, registry, opts, nil)
}

// The private verifier parameter supports in-process TLS fixtures. Production
// always creates the public-DNS-pinned, normal-TLS verifier.
func newWithOptions(s *store.Store, registry *render.Registry, opts Options, verification *subscriptionVerification) http.Handler {
	origin, err := CanonicalPublicOrigin(opts.PublicOrigin)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fail(w, 500, "invalid server public origin configuration")
		})
	}
	trusted, err := parseTrustedProxies(opts.TrustedProxyCIDRs)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fail(w, 500, "invalid trusted proxy configuration") })
	}
	opts.PublicOrigin = origin
	opts.SecureCookies = opts.SecureCookies || origin != ""
	if verification == nil {
		verification = newSubscriptionVerification()
	}
	h := &server{trustedProxies: trusted, s: s, registry: registry, opts: opts, attempts: map[string]attempt{}, subscriptionVerification: verification}
	root := chi.NewRouter()
	root.Use(h.headers)
	root.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "deploymentAvailable": false})
	})
	root.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if e := s.Ready(r.Context()); e != nil {
			fail(w, 503, "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	root.Get("/feed/verify/{challenge}", verification.serveChallenge)
	root.Get("/feed/{token}", h.feed)
	root.Get("/feed/{token}/bundle", h.feedBundle)
	root.Route("/api", func(r chi.Router) {
		h.registerAgent(r)
		r.Post("/auth/login", h.login)
		r.Post("/auth/accept-invite", h.acceptInvite)
		r.Group(func(r chi.Router) {
			r.Use(h.authenticate)
			h.registerAccountSecurity(r)
			r.Get("/auth/me", h.me)
			r.Post("/auth/logout", h.logout)
			r.Post("/auth/mfa/setup", h.setupMFA)
			r.Post("/auth/mfa/enable", h.enableMFA)
			h.registerTenant(r)
			h.registerTemplates(r)
			h.registerNotifications(r)
			r.Group(func(r chi.Router) {
				r.Use(requireAdmin)
				h.registerAdmin(r)
				h.registerBackup(r)
				h.registerNotificationAdmin(r)
				config := huma.DefaultConfig("RouteWeaver", "0.2.0")
				config.OpenAPIPath = "/openapi"
				config.DocsPath = "/docs"
				config.SchemasPath = "/schemas"
				api := humachi.New(r, config)
				huma.Get(api, "/state", func(ctx context.Context, in *struct{}) (*StateOutput, error) {
					st, e := s.State()
					if e != nil {
						return nil, huma.Error500InternalServerError("cannot read state")
					}
					for i := range st.Users {
						overview, err := h.overview(st.Users[i].ID, time.Now())
						if err != nil {
							return nil, huma.Error500InternalServerError("cannot calculate user usage")
						}
						st.Users[i].UsedBytes = overview.Usage.WeightedBytes
					}
					return &StateOutput{Body: StateBody{State: st, Capabilities: registry.Capabilities()}}, nil
				})
				registerCRUD(api, s, registry)
				registerRender(api, s, registry)
				registerSubscriptions(api, s, registry, h)
			})
		})
	})
	if opts.UIDir != "" {
		root.Get("/*", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/feed/") {
				fail(w, 404, "not found")
				return
			}
			rel := filepath.Clean("/" + r.URL.Path)
			path := filepath.Join(opts.UIDir, rel)
			if info, e := os.Stat(path); e == nil && !info.IsDir() {
				http.ServeFile(w, r, path)
				return
			}
			http.ServeFile(w, r, filepath.Join(opts.UIDir, "index.html"))
		})
	}
	return root
}
func (h *server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		bodyLimit := int64(2 << 20)
		if r.URL.Path == "/api/me/resources/import" {
			bodyLimit = 12 << 20
		}
		if r.URL.Path == "/api/admin/backups/preview" || r.URL.Path == "/api/admin/backups/restore" {
			bodyLimit = 23 << 20
			if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				bodyLimit = backup.MaxStreamBytes + (64 << 10)
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			if !validMutationOrigin(r, h.opts.PublicOrigin) {
				fail(w, 403, "cross-origin mutation rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func (h *server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := principal{}
		header := r.Header.Get("Authorization")
		if strings.HasPrefix(header, "Bearer ") && len(h.opts.AdminToken) >= 32 && subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, "Bearer ")), []byte(h.opts.AdminToken)) == 1 {
			p.Account = store.Account{ID: "operator", Name: "Operator", Role: "admin"}
			p.Bearer = true
		} else {
			cookie, e := r.Cookie("routeweaver_session")
			if e != nil {
				fail(w, 401, "authentication required")
				return
			}
			a, s, e := h.s.ResolveSession(cookie.Value, time.Now())
			if e != nil {
				fail(w, 401, "session invalid or expired")
				return
			}
			if a.PasswordChangeRequired && !passwordResetRoute(r.URL.Path) {
				fail(w, 403, "password change required before continuing")
				return
			}
			p.Account = a
			p.Session = s
			if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.CSRFToken)) != 1 {
				fail(w, 403, "CSRF token required")
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	})
}
func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if current(r).Account.Role != "admin" {
			fail(w, 403, "administrator permission required")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"detail": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid JSON request")
		return false
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		fail(w, 400, "request must contain one JSON value")
		return false
	}
	return true
}
func storeError(w http.ResponseWriter, e error) {
	if errors.Is(e, store.ErrConflict) {
		fail(w, 409, e.Error())
	} else if errors.Is(e, store.ErrNotFound) {
		fail(w, 404, "not found")
	} else {
		fail(w, 400, e.Error())
	}
}

func passwordResetRoute(path string) bool {
	return path == "/api/auth/me" || path == "/api/auth/password" || path == "/api/auth/logout" || path == "/api/auth/sessions" || strings.HasPrefix(path, "/api/auth/sessions/")
}
