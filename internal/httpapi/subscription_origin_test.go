package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/resources"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const subscriptionTestAdmin = "012345678901234567890123456789012345"

func subscriptionTestStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{23}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func subscriptionRequest(t *testing.T, h http.Handler, method, path string, body any, admin bool) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	if admin {
		r.Header.Set("Authorization", "Bearer "+subscriptionTestAdmin)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
	return w.Code, out
}
func TestSubscriptionOriginStageIsAdminOnlyAndNeverActivates(t *testing.T) {
	h := NewWithOptions(subscriptionTestStore(t), render.Default(), Options{AdminToken: subscriptionTestAdmin})
	path := "/api/admin/subscription-origin"
	if code, _ := subscriptionRequest(t, h, "GET", path, nil, false); code != 401 {
		t.Fatalf("anonymous settings: %d", code)
	}
	code, initial := subscriptionRequest(t, h, "GET", path, nil, true)
	if code != 200 || initial["revision"] != float64(0) {
		t.Fatalf("initial: %d %#v", code, initial)
	}
	code, staged := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://subscriptions.example.com", "expectedRevision": 0}, true)
	if code != 200 || staged["draftOrigin"] != "https://subscriptions.example.com" || staged["effectiveOrigin"] != "" || staged["configuredRevision"] != float64(1) || staged["effectiveRevision"] != float64(0) || staged["verificationStatus"] != "unverified" {
		t.Fatalf("staged: %d %#v", code, staged)
	}
	code, _ = subscriptionRequest(t, h, "POST", path+"/activate", map[string]any{"expectedRevision": 1}, true)
	if code != 409 {
		t.Fatalf("unverified draft activated: %d", code)
	}
	for _, origin := range []string{"http://subscriptions.example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://user:secret@example.com", "https://example.com/feed/token", "https://example.com?secret=token", "https://example.com#token"} {
		code, _ = subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": origin, "expectedRevision": 1}, true)
		if code != 400 {
			t.Fatalf("unsafe origin accepted %s: %d", origin, code)
		}
	}
	code, after := subscriptionRequest(t, h, "GET", path, nil, true)
	if code != 200 || after["draftOrigin"] != staged["draftOrigin"] || after["revision"] != staged["revision"] {
		t.Fatalf("rejected draft lost previous state: %#v", after)
	}
}

// This adapter terminates normal hostname-verified TLS over net.Pipe. No DNS,
// loopback listener, external destination, or live certificate is used.
func subscriptionTLSFixture(t *testing.T, target *http.Handler, serve func(http.ResponseWriter, *http.Request)) *http.Client {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"subscriptions.example.com", "replacement.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, DisableKeepAlives: true, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			_ = server.SetDeadline(time.Now().Add(3 * time.Second))
			secured := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: private}}, MinVersion: tls.VersionTLS12})
			defer secured.Close()
			request, e := http.ReadRequest(bufio.NewReader(secured))
			if e != nil {
				return
			}
			w := httptest.NewRecorder()
			if serve != nil {
				serve(w, request)
			} else {
				(*target).ServeHTTP(w, request)
			}
			_ = w.Result().Write(secured)
		}()
		return client, nil
	}}
	client := resources.OutboundClient(3 * time.Second)
	client.Transport = transport
	t.Cleanup(transport.CloseIdleConnections)
	return client
}

func TestSubscriptionOriginVerifiedActivationRetainsTokensAndSurvivesFailedReplacement(t *testing.T) {
	s := subscriptionTestStore(t)
	now := time.Now().UTC()
	var h http.Handler
	verifier := newSubscriptionVerification()
	verifier.now = func() time.Time { return now }
	verifier.client = subscriptionTLSFixture(t, &h, nil)
	h = newWithOptions(s, render.Default(), Options{AdminToken: subscriptionTestAdmin}, verifier)
	path := "/api/admin/subscription-origin"
	token, err := auth.Token()
	if err != nil {
		t.Fatal(err)
	}
	output := Output{ID: "origin-feed", Name: "Origin feed", Status: "published", Token: token, TokenDigest: auth.Digest(token), Artifacts: []domain.Artifact{{Content: `{"fixture":true}`}}}
	if err = s.PutUser(domain.User{ID: "operator", Name: "Operator", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("accounts", "operator", store.Account{ID: "operator", Name: "Operator", Role: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("entitlements", "operator", service.Entitlement{UserID: "operator", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Anchor: now.Add(-time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err = s.CompareAndPutWithToken(store.TenantKind("operator", "outputs"), output.ID, nil, output, "feeds", "", output.TokenDigest, "operator/"+output.ID); err != nil {
		t.Fatal(err)
	}
	code, access := subscriptionRequest(t, h, "GET", "/api/me/outputs/origin-feed/access", nil, true)
	if code != 200 || access["feedURL"] != "/feed/"+token {
		t.Fatalf("default access: %d %#v", code, access)
	}

	code, staged := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://subscriptions.example.com", "expectedRevision": 0}, true)
	if code != 200 {
		t.Fatalf("stage: %d %#v", code, staged)
	}
	code, verified := subscriptionRequest(t, h, "POST", path+"/verify", map[string]any{"expectedRevision": staged["revision"]}, true)
	if code != 200 || verified["verificationStatus"] != "verified" || verified["effectiveOrigin"] != "" {
		t.Fatalf("verify: %d %#v", code, verified)
	}
	code, active := subscriptionRequest(t, h, "POST", path+"/activate", map[string]any{"expectedRevision": verified["revision"]}, true)
	if code != 200 || active["effectiveOrigin"] != "https://subscriptions.example.com" || active["effectiveRevision"] != staged["configuredRevision"] {
		t.Fatalf("activate: %d %#v", code, active)
	}

	_, access = subscriptionRequest(t, h, "GET", "/api/me/outputs/origin-feed/access", nil, true)
	if access["feedPath"] != "/feed/"+token || access["feedURL"] != "https://subscriptions.example.com/feed/"+token {
		t.Fatalf("current origin or token wrong: %#v", access)
	}
	for _, origin := range []string{"https://old-domain.example.com", "https://subscriptions.example.com"} {
		code, _ = subscriptionRequest(t, h, "GET", origin+"/feed/"+token, nil, false)
		if code != 200 {
			t.Fatalf("domain switch revoked or redirected existing token: %d", code)
		}
	}
	code, rotated := subscriptionRequest(t, h, "POST", "/api/me/outputs/origin-feed/rotate", map[string]any{}, true)
	if code != 200 || rotated["feedPath"] == "/feed/"+token {
		t.Fatalf("rotate: %d %#v", code, rotated)
	}
	for _, origin := range []string{"https://old-domain.example.com", "https://subscriptions.example.com"} {
		code, _ = subscriptionRequest(t, h, "GET", origin+"/feed/"+token, nil, false)
		if code != 404 {
			t.Fatalf("old token survived rotation: %d", code)
		}
	}
	_, settings := subscriptionRequest(t, h, "GET", path, nil, true)
	encoded, _ := json.Marshal(settings)
	if strings.Contains(string(encoded), token) {
		t.Fatal("settings revealed a feed token")
	}
	// Replacing a working domain is staged; a failed probe cannot remove it.
	code, replacement := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://replacement.example.com", "expectedRevision": active["revision"]}, true)
	if code != 200 {
		t.Fatalf("replacement: %d %#v", code, replacement)
	}
	verifier.client = subscriptionTLSFixture(t, &h, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("different instance")) })
	code, _ = subscriptionRequest(t, h, "POST", path+"/verify", map[string]any{"expectedRevision": replacement["revision"]}, true)
	if code != 422 {
		t.Fatalf("wrong instance accepted: %d", code)
	}
	_, after := subscriptionRequest(t, h, "GET", path, nil, true)
	if after["effectiveOrigin"] != "https://subscriptions.example.com" || after["draftOrigin"] != "https://replacement.example.com" || after["verificationStatus"] != "failed" || after["effectiveRevision"] != active["effectiveRevision"] {
		t.Fatalf("failure damaged settings: %#v", after)
	}
}

func TestSubscriptionOriginProofExpiresAndConcurrentEditFencesVerification(t *testing.T) {
	now := time.Now().UTC()
	var h http.Handler
	verifier := newSubscriptionVerification()
	verifier.now = func() time.Time { return now }
	verifier.client = subscriptionTLSFixture(t, &h, nil)
	h = newWithOptions(subscriptionTestStore(t), render.Default(), Options{AdminToken: subscriptionTestAdmin}, verifier)
	path := "/api/admin/subscription-origin"
	_, draft := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://subscriptions.example.com", "expectedRevision": 0}, true)
	code, proof := subscriptionRequest(t, h, "POST", path+"/verify", map[string]any{"expectedRevision": draft["revision"]}, true)
	if code != 200 {
		t.Fatalf("verify: %d %#v", code, proof)
	}
	now = now.Add(5 * time.Minute)
	code, _ = subscriptionRequest(t, h, "POST", path+"/activate", map[string]any{"expectedRevision": proof["revision"]}, true)
	if code != 409 {
		t.Fatalf("expired proof activated: %d", code)
	}
	_, expired := subscriptionRequest(t, h, "GET", path, nil, true)
	if expired["verificationStatus"] != "expired" || expired["effectiveOrigin"] != "" || expired["draftOrigin"] != draft["draftOrigin"] {
		t.Fatalf("expiry damaged draft: %#v", expired)
	}
	// An in-flight successful probe cannot overwrite a newer saved draft.
	started := make(chan struct{})
	release := make(chan struct{})
	verifier.client = subscriptionTLSFixture(t, &h, func(w http.ResponseWriter, r *http.Request) { close(started); <-release; h.ServeHTTP(w, r) })
	done := make(chan int, 1)
	go func() {
		b, _ := json.Marshal(map[string]any{"expectedRevision": proof["revision"]})
		r := httptest.NewRequest("POST", path+"/verify", bytes.NewReader(b))
		r.Header.Set("Authorization", "Bearer "+subscriptionTestAdmin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		done <- w.Code
	}()
	<-started
	code, newDraft := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://replacement.example.com", "expectedRevision": proof["revision"]}, true)
	if code != 200 {
		t.Fatalf("concurrent stage: %d %#v", code, newDraft)
	}
	close(release)
	if code = <-done; code != 409 {
		t.Fatalf("stale verification overwrote draft: %d", code)
	}
	_, after := subscriptionRequest(t, h, "GET", path, nil, true)
	if after["draftOrigin"] != "https://replacement.example.com" || after["revision"] != newDraft["revision"] || after["verificationStatus"] != "unverified" || after["verifiedAt"] != nil {
		t.Fatalf("stale proof retained: %#v", after)
	}
	code, _ = subscriptionRequest(t, h, "POST", path+"/activate", map[string]any{"expectedRevision": proof["revision"]}, true)
	if code != 409 {
		t.Fatalf("stale activation: %d", code)
	}
	code, _ = subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "https://subscriptions.example.com", "expectedRevision": proof["revision"]}, true)
	if code != 409 {
		t.Fatalf("stale save: %d", code)
	}
	// Returning to the explicit server default is a distinct saved activation,
	// not an excuse to reuse the old custom-domain proof.
	code, reset := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": "", "expectedRevision": after["revision"]}, true)
	if code != 200 {
		t.Fatalf("reset draft: %d %#v", code, reset)
	}
	code, active := subscriptionRequest(t, h, "POST", path+"/activate", map[string]any{"expectedRevision": reset["revision"]}, true)
	if code != 200 || active["effectiveRevision"] != reset["configuredRevision"] || active["effectiveOrigin"] != "" {
		t.Fatalf("reset activation: %d %#v", code, active)
	}
}

func TestSubscriptionOriginVerificationRejectsRedirectsAndInvalidTLS(t *testing.T) {
	for _, mode := range []string{"redirect", "untrusted-certificate", "wrong-hostname", "wrong-challenge-host", "oversized-answer"} {
		t.Run(mode, func(t *testing.T) {
			var h http.Handler
			verifier := newSubscriptionVerification()
			var calls atomic.Int32
			verifier.client = subscriptionTLSFixture(t, &h, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("admin credentials sent to candidate origin")
				}
				switch mode {
				case "redirect":
					w.Header().Set("Location", "https://replacement.example.com/redirected")
					w.WriteHeader(307)
				case "wrong-challenge-host":
					r.Host = "wrong.example.com"
					h.ServeHTTP(w, r)
				case "oversized-answer":
					h.ServeHTTP(w, r)
					w.Write([]byte(strings.Repeat("x", 256)))
				default:
					h.ServeHTTP(w, r)
				}
			})
			if mode == "untrusted-certificate" {
				verifier.client.Transport.(*http.Transport).TLSClientConfig.RootCAs = x509.NewCertPool()
			}
			h = newWithOptions(subscriptionTestStore(t), render.Default(), Options{AdminToken: subscriptionTestAdmin}, verifier)
			origin := "https://subscriptions.example.com"
			if mode == "wrong-hostname" {
				origin = "https://wrong.example.com"
			}
			path := "/api/admin/subscription-origin"
			_, draft := subscriptionRequest(t, h, "PUT", path, map[string]any{"origin": origin, "expectedRevision": 0}, true)
			code, _ := subscriptionRequest(t, h, "POST", path+"/verify", map[string]any{"expectedRevision": draft["revision"]}, true)
			if code != 422 {
				t.Fatalf("%s probe accepted: %d", mode, code)
			}
			if mode == "redirect" && calls.Load() != 1 {
				t.Fatalf("redirect followed: %d requests", calls.Load())
			}
			if (mode == "untrusted-certificate" || mode == "wrong-hostname") && calls.Load() != 0 {
				t.Fatal("invalid TLS reached HTTP handler")
			}
			_, state := subscriptionRequest(t, h, "GET", path, nil, true)
			if state["draftOrigin"] != origin || state["effectiveOrigin"] != "" || state["verificationStatus"] != "failed" || state["verificationExpiresAt"] != nil {
				t.Fatalf("failed proof retained: %#v", state)
			}
		})
	}
}

func TestSubscriptionOriginUsesOnlyExplicitDefaultAndAdminMayMaintainIt(t *testing.T) {
	s := subscriptionTestStore(t)
	if err := s.Put("accounts", "operator", store.Account{ID: "operator", Name: "Operator", Role: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutUser(domain.User{ID: "operator", Name: "Operator", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	h := NewWithOptions(s, render.Default(), Options{AdminToken: subscriptionTestAdmin, PublicOrigin: "https://console.example.com"})
	v := Output{ID: "origin-default", Status: "published", Token: strings.Repeat("x", 43)}
	if err := s.TenantPut("operator", "outputs", v.ID, v); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "https://untrusted.example.com/api/me/outputs/origin-default/access", nil)
	r.Header.Set("Authorization", "Bearer "+subscriptionTestAdmin)
	r.Header.Set("X-Forwarded-Host", "redirect.example.com")
	r.Header.Set("X-Forwarded-Proto", "http")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var access map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &access); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || access["feedURL"] != "https://console.example.com/feed/"+v.Token {
		t.Fatalf("untrusted host altered feed: %d %#v", w.Code, access)
	}
	// A normal member cannot view domain settings or initiate outbound probes.
	_, token, err := s.CreateInvite("Member", "user", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	account, err := s.AcceptInvite(token, "origin-member", "synthetic-member-password")
	if err != nil {
		t.Fatal(err)
	}
	session, sessionToken, err := s.NewSession(account, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT", "POST"} {
		path := "/api/admin/subscription-origin"
		if method == "POST" {
			path += "/verify"
		}
		request := httptest.NewRequest(method, path, strings.NewReader(`{"origin":"https://subscriptions.example.com","expectedRevision":0}`))
		request.AddCookie(&http.Cookie{Name: "routeweaver_session", Value: sessionToken})
		request.Header.Set("X-CSRF-Token", session.CSRFToken)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("member %s allowed: %d %s", method, response.Code, response.Body.String())
		}
	}
}
