package httpapi_test

import (
	"reflect"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// Exercise the real HTTP publication seam. A no-op recipe is allowed to be
// explicitly published again (new publication revision), but cannot rotate a
// feed, change rendered bytes, or silently republish a sibling.
func TestNoOpProcessingRecipePreservesPublishedContentAndSibling(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "noop-processing-owner")
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, result, raw := req(t, owner.c, method, srv.URL+path, owner.csrf, body)
		if code != want {
			t.Fatalf("%s %s: %d %s", method, path, code, raw)
		}
		return result
	}
	call("POST", "/api/me/sources", map[string]any{"id": "source", "name": "No-op source", "kind": "text", "enabled": true, "content": "socks5://one.example.test:1080#One\nsocks5://two.example.test:1080#Two"}, 200)
	sourceBefore := call("GET", "/api/me/sources/source/reveal", nil, 200)
	collection := domain.Collection{ID: "collection", Name: "No-op collection", Sources: []domain.CollectionSource{{SourceID: "source"}}, Steps: []domain.ProcessingStep{}}
	call("POST", "/api/me/collections", collection, 200)
	profile := templateTestProfile("profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	profile.CollectionID = "collection"
	profile.IR.Endpoints = nil
	call("POST", "/api/me/profiles", profile, 200)
	outputs := map[string]httpapi.Output{}
	feeds := map[string]string{}
	feedPaths := map[string]string{}
	readFeed := func(path string) string {
		t.Helper()
		code, _, raw := req(t, owner.c, "GET", srv.URL+path, "", nil)
		if code != 200 {
			t.Fatalf("feed: %d %s", code, raw)
		}
		return raw
	}
	for _, id := range []string{"selected", "sibling"} {
		created := call("POST", "/api/me/outputs", map[string]any{"id": id, "name": id, "profileId": "profile"}, 201)
		feedPaths[id] = created["feedPath"].(string)
		feeds[id] = readFeed(feedPaths[id])
		var output httpapi.Output
		if err := s.TenantGet(owner.id, "outputs", id, &output); err != nil {
			t.Fatal(err)
		}
		outputs[id] = output
	}
	unchanged := func() {
		t.Helper()
		for id, want := range outputs {
			var got httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", id, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("preview/save changed complete %s publication", id)
			}
			if got := readFeed(feedPaths[id]); got != feeds[id] {
				t.Fatalf("preview/save changed %s feed", id)
			}
		}
		if got := call("GET", "/api/me/sources/source/reveal", nil, 200); !reflect.DeepEqual(got, sourceBefore) {
			t.Fatal("processing mutated accepted source")
		}
	}
	collection.Steps = []domain.ProcessingStep{
		{ID: "same-name", Kind: "rename", Enabled: true, Template: "{name}"},
		{ID: "same-protocol-order", Kind: "sort", Enabled: true, SortBy: "protocol"},
		{ID: "disabled-drop", Kind: "drop", Enabled: false},
	}
	preview := call("POST", "/api/me/collections/preview", collection, 200)
	steps := []string{}
	for _, raw := range preview["stages"].([]any) {
		stage := raw.(map[string]any)
		if id, ok := stage["stepId"].(string); ok {
			steps = append(steps, id)
			if len(stage["changedIds"].([]any)) != 0 || len(stage["removedIds"].([]any)) != 0 {
				t.Fatalf("no-op preview invented changes: %#v", stage)
			}
		}
	}
	if !reflect.DeepEqual(steps, []string{"same-name", "same-protocol-order"}) {
		t.Fatalf("no-op stage order or disabled-step contract changed: %v", steps)
	}
	unchanged()
	call("PUT", "/api/me/collections/collection", collection, 200)
	unchanged()
	comparison := call("GET", "/api/me/outputs/selected/comparison", nil, 200)
	if comparison["draftComparison"].(map[string]any)["state"] != "unchanged" {
		t.Fatalf("no-op recipe falsely marked output changed: %#v", comparison)
	}
	review := call("POST", "/api/me/profiles/profile/preview", map[string]any{"outputId": "selected"}, 200)
	unchanged()
	call("POST", "/api/me/outputs/selected/publish", map[string]any{"previewDigest": review["previewDigest"]}, 200)
	var actual httpapi.Output
	if err := s.TenantGet(owner.id, "outputs", "selected", &actual); err != nil {
		t.Fatal(err)
	}
	before := outputs["selected"]
	if actual.Revision == before.Revision || actual.PublishedAt == nil {
		t.Fatal("explicit publication lost fresh revision")
	}
	if actual.Token != before.Token || actual.TokenDigest != before.TokenDigest || !reflect.DeepEqual(actual.Artifacts, before.Artifacts) {
		t.Fatal("no-op publication changed access identity or artifact bytes")
	}
	outputs["selected"] = actual
	unchanged()
	comparison = call("GET", "/api/me/outputs/selected/comparison", nil, 200)
	if comparison["draftComparison"].(map[string]any)["state"] != "unchanged" {
		t.Fatal("explicit no-op publication is not current")
	}
}
