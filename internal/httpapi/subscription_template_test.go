package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

func TestSubscriptionTemplateValidation(t *testing.T) {
	for _, v := range []string{"", "http://192.168.1.1:8080/sub/{token}", "https://example.com/download?token={token}&name=test", "https://my.ai.com/feed?sub={token}"} {
		if _, err := canonicalSubscriptionTemplate(v); err != nil {
			t.Errorf("valid %q: %v", v, err)
		}
	}
	for _, v := range []string{"ftp://example.com/{token}", "https://example.com/sub", "https://example.com/{token}/{token}", "https://{token}.example.com/sub", "https://user:pass@example.com/{token}", "https://example.com/api/{token}", "https://example.com/feed/prefix-{token}", "https://example.com/{unknown}/{token}"} {
		if _, err := canonicalSubscriptionTemplate(v); err == nil {
			t.Errorf("accepted %q", v)
		}
	}
}

func TestSubscriptionTemplateDeliveryAndRevocation(t *testing.T) {
	s := subscriptionTestStore(t)
	now := time.Now()
	token := strings.Repeat("x", 43)
	output := Output{ID: "template-feed", Status: "published", Token: token, TokenDigest: auth.Digest(token), Artifacts: []domain.Artifact{{Path: "mihomo.json", Content: `{"template":true}`}}}
	if err := s.PutUser(domain.User{ID: "operator", Name: "Operator", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("accounts", "operator", store.Account{ID: "operator", Name: "Operator", Role: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("entitlements", "operator", service.Entitlement{UserID: "operator", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Anchor: now.Add(-time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := s.CompareAndPutWithToken(store.TenantKind("operator", "outputs"), output.ID, nil, output, "feeds", "", output.TokenDigest, "operator/"+output.ID); err != nil {
		t.Fatal(err)
	}
	h := NewWithOptions(s, render.Default(), Options{AdminToken: subscriptionTestAdmin})
	revision := 0
	for _, template := range []string{"http://192.168.1.1:8080/sub/{token}?name=test", "https://example.com/download?token={token}&name=test", "https://my.ai.com/feed?sub={token}"} {
		code, state := subscriptionRequest(t, h, "PUT", "/api/admin/subscription-origin", map[string]any{"origin": "", "linkTemplate": template, "applyImmediately": true, "expectedRevision": revision}, true)
		if code != 200 {
			t.Fatalf("save %d %#v", code, state)
		}
		revision++
		_, access := subscriptionRequest(t, h, "GET", "/api/me/outputs/template-feed/access", nil, true)
		expected := strings.ReplaceAll(template, "{token}", token)
		if access["feedURL"] != expected {
			t.Fatalf("access %#v", access)
		}
		for _, target := range []string{access["feedPath"].(string), "/feed/" + token} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
			if w.Code != 200 {
				t.Fatalf("delivery %s: %d %s", target, w.Code, w.Body.String())
			}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", access["bundlePath"].(string), nil))
		if w.Code != 200 || w.Header().Get("Content-Type") != "application/zip" {
			t.Fatalf("bundle route missing: %s", w.Body.String())
		}
	}
	if code, _ := subscriptionRequest(t, h, "POST", "/api/me/outputs/template-feed/rotate", map[string]any{}, true); code != 200 {
		t.Fatalf("rotate: %d", code)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/feed?sub="+token, nil))
	if w.Code != 404 {
		t.Fatalf("revoked token: %d", w.Code)
	}
}
