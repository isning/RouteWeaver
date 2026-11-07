package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func readTemplateDeleteFeed(t *testing.T, url string) (int, string) {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatal("could not request published fixture")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal("could not read published fixture")
	}
	return response.StatusCode, string(body)
}

// Deleting a draft ends its template relationship. Reusing the identity must
// adopt a template afresh, not inherit the deleted draft's merge baseline.
func TestTemplateTargetDeletionEndsRelationshipBeforeIdentityReuse(t *testing.T) {
	for _, kind := range []string{"profiles", "collections"} {
		t.Run(kind, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "template-delete-owner")
			other := inviteClient(t, s, srv, "template-delete-other")
			var target any = templateTestProfile("shared", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			library, template := "profile-library", profileTemplate(0, baseProfileSpec())
			if kind == "collections" {
				target = domain.Collection{ID: "shared", Name: "Fresh collection", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
				library, template = "names", processingTemplate(0, "Shared {name}")
			}
			if code, _, _ := adminTemplateRequest(t, srv, template); code != 201 {
				t.Fatalf("publish template: status %d", code)
			}
			request := func(user sessionClient, method, path string, body any, want int) string {
				t.Helper()
				code, _, raw := req(t, user.c, method, srv.URL+"/api/me/"+path, user.csrf, body)
				if code != want {
					t.Fatalf("%s %s: want status %d, got %d", method, path, want, code)
				}
				return raw
			}
			selection := map[string]any{"mode": "follow", "version": 1, "targetId": "shared"}
			for _, user := range []sessionClient{owner, other} {
				request(user, "POST", kind, target, 200)
				request(user, "POST", "templates/"+library+"/select", selection, 200)
			}
			otherTarget := request(other, "GET", kind+"/shared", nil, 200)
			otherBindings := request(other, "GET", "template-bindings", nil, 200)
			beforeBindings := request(owner, "GET", "template-bindings", nil, 200)
			if code, _, _ := req(t, owner.c, "DELETE", srv.URL+"/api/me/"+kind+"/shared", "", nil); code != 403 {
				t.Fatalf("delete without CSRF: status %d", code)
			}
			if got := request(owner, "GET", "template-bindings", nil, 200); got != beforeBindings {
				t.Fatal("rejected deletion changed the binding")
			}
			request(owner, "DELETE", kind+"/shared", nil, 200)
			request(owner, "GET", kind+"/shared", nil, 404)
			var bindings []json.RawMessage
			if err := json.Unmarshal([]byte(request(owner, "GET", "template-bindings", nil, 200)), &bindings); err != nil {
				t.Fatal(err)
			}
			if len(bindings) != 0 {
				t.Errorf("deleted draft retained %d template relationships", len(bindings))
			}
			request(owner, "POST", "template-bindings/"+kind+"_shared/preview", map[string]any{}, 404)
			if got := request(other, "GET", "template-bindings", nil, 200); got != otherBindings {
				t.Fatal("deletion changed another tenant's same-ID binding")
			}
			if got := request(other, "GET", kind+"/shared", nil, 200); got != otherTarget {
				t.Fatal("deletion changed another tenant's same-ID draft")
			}
			request(owner, "POST", kind, target, 200)
			request(owner, "POST", "templates/"+library+"/select", selection, 200)
			raw := request(owner, "GET", kind+"/shared", nil, 200)
			if kind == "profiles" {
				var saved struct {
					IR domain.ClientProfileIR `json:"ir"`
				}
				if err := json.Unmarshal([]byte(raw), &saved); err != nil {
					t.Fatal(err)
				}
				if len(saved.IR.Groups) != 1 || saved.IR.Groups[0].ID != "proxy" || saved.IR.DefaultAction != (domain.ActionRef{Kind: "group", Ref: "proxy"}) {
					t.Fatal("fresh draft inherited deleted profile's baseline")
				}
			} else {
				var saved domain.Collection
				if err := json.Unmarshal([]byte(raw), &saved); err != nil {
					t.Fatal(err)
				}
				if len(saved.Steps) != 1 || saved.Steps[0].ID != "rename" || saved.Steps[0].Template != "Shared {name}" {
					t.Fatal("fresh draft inherited deleted collection's baseline")
				}
			}
		})
	}
}

func TestTemplateTargetBlockedDeletionPreservesDraftBindingAndPublishedFeed(t *testing.T) {
	for _, kind := range []string{"profiles", "collections"} {
		t.Run(kind, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "template-delete-blocked")
			request := func(method, path string, body any, want int) (map[string]any, string) {
				t.Helper()
				code, value, raw := req(t, owner.c, method, srv.URL+"/api/me/"+path, owner.csrf, body)
				if code != want {
					t.Fatalf("%s %s: want status %d, got %d", method, path, want, code)
				}
				return value, raw
			}
			profile := templateTestProfile("shared", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			library, template := "profile-library", profileTemplate(0, baseProfileSpec())
			if kind == "collections" {
				request("POST", "collections", domain.Collection{ID: "shared", Name: "Referenced collection", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}, 200)
				profile.CollectionID = "shared"
				library, template = "names", processingTemplate(0, "Shared {name}")
			}
			request("POST", "profiles", profile, 200)
			if code, _, _ := adminTemplateRequest(t, srv, template); code != 201 {
				t.Fatalf("publish template: status %d", code)
			}
			request("POST", "templates/"+library+"/select", map[string]any{"mode": "follow", "targetId": "shared"}, 200)
			output, _ := request("POST", "outputs", map[string]any{"id": "frozen", "name": "Published", "profileId": "shared"}, 201)
			feed, ok := output["feedPath"].(string)
			if !ok || feed == "" {
				t.Fatal("published fixture lacks feed path")
			}
			code, published := readTemplateDeleteFeed(t, srv.URL+feed)
			if code != 200 {
				t.Fatalf("read published fixture: status %d", code)
			}
			_, draftBefore := request("GET", kind+"/shared", nil, 200)
			_, bindingsBefore := request("GET", "template-bindings", nil, 200)
			request("DELETE", kind+"/shared", nil, 409)
			if _, got := request("GET", kind+"/shared", nil, 200); got != draftBefore {
				t.Fatal("blocked deletion changed draft")
			}
			if _, got := request("GET", "template-bindings", nil, 200); got != bindingsBefore {
				t.Fatal("blocked deletion removed template relationship")
			}
			if code, got := readTemplateDeleteFeed(t, srv.URL+feed); code != 200 || got != published {
				t.Fatalf("blocked deletion changed published feed: status %d", code)
			}
		})
	}
}
