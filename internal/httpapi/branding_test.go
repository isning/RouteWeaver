package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestPlatformLogoSVGValidation(t *testing.T) {
	encode := func(value string) string {
		return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(value))
	}
	if !validBranding("My platform", encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"/></svg>`)) {
		t.Fatal("safe SVG rejected")
	}
	for _, value := range []string{
		`<svg><script>alert(1)</script></svg>`,
		`<svg onload="alert(1)"/>`,
		`<svg><use href="https://example.com/private"/></svg>`,
		`<svg><foreignObject/></svg>`,
		`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>`,
		`<svg><path fill="url(https://example.com/a)"/></svg>`,
		`<svg style="background:url(https://example.com/a)"/>`,
	} {
		if validBranding("Name", encode(value)) {
			t.Fatalf("unsafe SVG accepted: %s", value)
		}
	}
	if validBranding("Name", "https://example.com/logo.svg") || validBranding(" ", "") {
		t.Fatal("invalid branding accepted")
	}
}
func TestAnonymousBrandingOnlyExposesPublicFields(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{23}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("settings", "platform", Settings{Name: "Sample brand", Timezone: "UTC+8", Registration: "invite"}); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	New(s, render.Default(), "", "").ServeHTTP(response, httptest.NewRequest("GET", "/api/branding", nil))
	if response.Code != 200 {
		t.Fatalf("public branding: %d", response.Code)
	}
	var result map[string]any
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 4 || result["name"] != "Sample brand" {
		t.Fatal("private settings leaked or brand missing")
	}
}

func TestBrandingSettingsRequireAdminAndPreserveValidLogoOnRejection(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{26}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	token := strings.Repeat("a", 32)
	handler := New(s, render.Default(), token, "")
	svg := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>`))
	write := func(logo string, authorized bool) int {
		body, _ := json.Marshal(Settings{Name: "Brand", Logo: logo, Timezone: "UTC+8", Registration: "invite"})
		request := httptest.NewRequest("PUT", "/api/settings", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if authorized {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}
	if status := write(svg, false); status != 401 {
		t.Fatalf("anonymous settings write: %d", status)
	}
	if status := write(svg, true); status != 200 {
		t.Fatalf("valid logo settings write: %d", status)
	}
	if status := write("data:image/svg+xml;base64,"+base64.StdEncoding.EncodeToString([]byte(`<svg onload="alert(1)"/>`)), true); status != 400 {
		t.Fatalf("unsafe logo write: %d", status)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/branding", nil))
	var branding map[string]string
	if err = json.Unmarshal(response.Body.Bytes(), &branding); err != nil {
		t.Fatal(err)
	}
	if branding["logo"] != svg || branding["name"] != "Brand" {
		t.Fatal("valid branding changed after rejected write")
	}
}

func TestPlatformSettingsAllowTimezoneAndClosedRegistration(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{27}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	token := strings.Repeat("b", 32)
	handler := New(s, render.Default(), token, "")
	for _, zone := range []string{"Europe/London", "America/New_York", "UTC", "invalid-zone"} {
		body, _ := json.Marshal(Settings{Name: "Brand", Timezone: zone, Registration: "closed"})
		request := httptest.NewRequest("PUT", "/api/settings", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		expected := 200
		if zone == "invalid-zone" {
			expected = 400
		}
		if response.Code != expected {
			t.Fatalf("timezone %s: %d", zone, response.Code)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/branding", nil))
	var result map[string]string
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["timezone"] != "UTC" || result["registration"] != "closed" {
		t.Fatal("settings not publicly applied or rejected write replaced settings")
	}
}
