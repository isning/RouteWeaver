package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

const validationTestToken = "012345678901234567890123456789012345"

// Exercise the authenticated public handler without opening a network listener.
func validationHandler(t *testing.T) http.Handler {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "validation.db"), bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return httpapi.New(s, render.Default(), validationTestToken, "")
}

func validationRequest(t *testing.T, h http.Handler, path string, payload any) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+validationTestToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return w.Code, response
}

func TestProfilePreviewLocatesMissingDefaultReference(t *testing.T) {
	h := validationHandler(t)
	p := templateTestProfile("missing-default", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed-node"}
	status, response := validationRequest(t, h, "/api/me/profiles/preview", p)
	if status != 400 || response["detail"] != "defaultAction: endpoint reference missing" {
		t.Fatalf("legacy status/detail changed: %d %#v", status, response)
	}
	want := map[string]any{
		"code":      "missing_action_reference",
		"reference": map[string]any{"kind": "endpoint", "id": "removed-node"},
		"location":  map[string]any{"kind": "default"},
	}
	if !reflect.DeepEqual(response["validation"], want) {
		t.Fatalf("missing actionable default location: got %#v, want %#v", response["validation"], want)
	}
}

func TestOutputPreviewsLocateMissingReferenceWithoutChangingStatus(t *testing.T) {
	h := validationHandler(t)
	p := templateTestProfile("output-feedback", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	if status, response := validationRequest(t, h, "/api/me/profiles", p); status != 200 {
		t.Fatalf("save valid profile: %d %#v", status, response)
	}
	if status, response := validationRequest(t, h, "/api/me/outputs", map[string]string{"id": "existing-output", "name": "Existing", "profileId": p.ID}); status != 201 {
		t.Fatalf("create output: %d %#v", status, response)
	}
	p.IR.DefaultAction = domain.ActionRef{Kind: "group", Ref: "removed-group"}
	if status, response := validationRequest(t, h, "/api/me/profiles", p); status != 200 {
		t.Fatalf("preserve invalid draft: %d %#v", status, response)
	}
	for _, tc := range []struct {
		name string
		path string
		body any
	}{
		{"new output", "/api/me/outputs/preview", map[string]string{"id": "new-output", "name": "New", "profileId": p.ID}},
		{"existing output", "/api/me/profiles/" + p.ID + "/preview", map[string]string{"outputId": "existing-output"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, response := validationRequest(t, h, tc.path, tc.body)
			if status != 422 || response["detail"] != "defaultAction: group reference missing" {
				t.Fatalf("legacy output failure changed: %d %#v", status, response)
			}
			want := map[string]any{
				"code":      "missing_action_reference",
				"reference": map[string]any{"kind": "group", "id": "removed-group"},
				"location":  map[string]any{"kind": "default"},
			}
			if !reflect.DeepEqual(response["validation"], want) {
				t.Fatalf("missing output repair location: got %#v, want %#v", response["validation"], want)
			}
		})
	}
}

func TestProfilePreviewLocatesGroupAndRuleActionsByIdentity(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mutate   func(*httpapi.Profile)
		detail   string
		location map[string]any
	}{
		{"group member", func(p *httpapi.Profile) {
			p.IR.Groups = []domain.PolicyGroup{{ID: "stable-group", Name: "Choice", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "removed-node"}}}}
		}, "groups[0]: endpoint reference missing", map[string]any{"kind": "group", "id": "stable-group"}},
		{"rule action", func(p *httpapi.Profile) {
			p.IR.Rules = []domain.PolicyRule{{ID: "stable-rule", Match: domain.MatchExpression{Op: "domain", Value: "example.org"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed-node"}}}
		}, "rules[0].action: endpoint reference missing", map[string]any{"kind": "rule", "id": "stable-rule"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := validationHandler(t)
			p := templateTestProfile("location-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			tc.mutate(&p)
			status, response := validationRequest(t, h, "/api/me/profiles/preview", p)
			want := map[string]any{"code": "missing_action_reference", "reference": map[string]any{"kind": "endpoint", "id": "removed-node"}, "location": tc.location}
			if status != 400 || response["detail"] != tc.detail || !reflect.DeepEqual(response["validation"], want) {
				t.Fatalf("unusable repair location: %d %#v", status, response)
			}
		})
	}
}

func TestProfilePreviewLeavesUnrelatedFailuresUnclassified(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*httpapi.Profile)
		status int
		detail string
	}{
		{"owner mismatch", func(p *httpapi.Profile) {
			p.IR.OwnerID = "other-owner"
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"}
		}, 400, "resource owner mismatch"},
		{"missing source", func(p *httpapi.Profile) {
			p.SourceIDs = []string{"another-tenants-source"}
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"}
		}, 400, "source is missing or not owned"},
		{"malformed action", func(p *httpapi.Profile) { p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "invalid/ref"} }, 400, "defaultAction: endpoint reference missing"},
		{"unknown action", func(p *httpapi.Profile) { p.IR.DefaultAction = domain.ActionRef{Kind: "unknown", Ref: "removed"} }, 400, "defaultAction: unknown action kind"},
		{"resource match", func(p *httpapi.Profile) {
			p.IR.Rules = []domain.PolicyRule{{ID: "resource-rule", Match: domain.MatchExpression{Op: "resource", Value: "removed"}, Action: domain.ActionRef{Kind: "direct"}}}
		}, 400, "rules[0].match: rule resource reference missing"},
		{"cycle", func(p *httpapi.Profile) {
			p.IR.Groups = []domain.PolicyGroup{{ID: "cycle-group", Name: "Cycle", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "cycle-group"}}}}
		}, 400, "group cycle at cycle-group"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := validationHandler(t)
			p := templateTestProfile("other-failure", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			tc.mutate(&p)
			status, response := validationRequest(t, h, "/api/me/profiles/preview", p)
			if status != tc.status || response["detail"] != tc.detail || response["validation"] != nil {
				t.Fatalf("unrelated failure changed: %d %#v", status, response)
			}
		})
	}
}

func TestProfilePreviewAuthorizationPrecedesValidationMetadata(t *testing.T) {
	h := validationHandler(t)
	p := templateTestProfile("auth-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed-node"}
	body, _ := json.Marshal(p)
	for _, tc := range []struct {
		name, authorization, origin string
		want                        int
	}{
		{"unauthenticated", "", "", 401},
		{"forbidden origin", "Bearer " + validationTestToken, "https://untrusted.example", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/me/profiles/preview", bytes.NewReader(body))
			r.Header.Set("Authorization", tc.authorization)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			var response map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.want || response["validation"] != nil {
				t.Fatalf("validation escaped authorization: %d %#v", w.Code, response)
			}
		})
	}
}

func TestOutputPreviewConflictPrecedesValidationMetadata(t *testing.T) {
	h := validationHandler(t)
	p := templateTestProfile("original-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	if status, response := validationRequest(t, h, "/api/me/profiles", p); status != 200 {
		t.Fatal(status, response)
	}
	if status, response := validationRequest(t, h, "/api/me/outputs", map[string]string{"id": "conflicting-output", "name": "Existing", "profileId": p.ID}); status != 201 {
		t.Fatal(status, response)
	}
	p.ID = "different-profile"
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed-node"}
	if status, response := validationRequest(t, h, "/api/me/profiles", p); status != 200 {
		t.Fatal(status, response)
	}
	for _, tc := range []struct {
		path string
		body any
	}{
		{"/api/me/profiles/different-profile/preview", map[string]string{"outputId": "conflicting-output"}},
		{"/api/me/outputs/preview", map[string]string{"id": "conflicting-output", "name": "Conflicting", "profileId": p.ID}},
	} {
		status, response := validationRequest(t, h, tc.path, tc.body)
		if status != 409 || response["validation"] != nil {
			t.Fatalf("conflict classified as validation: %d %#v", status, response)
		}
	}
}
