package httpapi_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestSecondaryPresetDigestRejectsChangedSource(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "secondary-preview")
	source := map[string]any{"id": "source", "applyMode": "manual", "name": "Private source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-secret@192.0.2.10:1080#Original", "enabled": true}
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	collection := map[string]any{"id": "collection", "name": "Collection", "sources": []any{map[string]any{"sourceId": "source", "steps": []any{}}}, "steps": []any{}}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, collection)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = adminTemplateRequest(t, srv, processingTemplate(0, "First {name}"))
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"mode": "follow", "targetId": "collection"})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "Second {name}"))
	if code != 201 {
		t.Fatal(raw)
	}
	code, before, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if code != 200 || before["compatible"] != true {
		t.Fatal(raw)
	}
	if !strings.Contains(raw, "192.0.2.10") {
		t.Fatal("original host not in artifact")
	}
	source["content"] = "socks5://fixture-user:fixture-secret@192.0.2.20:1080#Different"
	code, pending, raw := req(t, u.c, "PUT", srv.URL+"/api/me/sources/source", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	candidate, ok := pending["candidate"].(map[string]any)
	if !ok {
		t.Fatalf("material source change did not request review: %s", raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/sources/source/candidate/accept", u.csrf, map[string]any{"candidateId": candidate["id"], "sourceRevision": pending["revision"]})
	if code != 200 {
		t.Fatal(raw)
	}
	code, after, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if code != 200 || after["compatible"] != true {
		t.Fatal(raw)
	}
	if !strings.Contains(raw, "192.0.2.20") {
		t.Fatal("updated host not in artifact")
	}
	t.Logf("artifact host changed; same digest=%v", before["previewDigest"] == after["previewDigest"])
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/apply", u.csrf, map[string]any{"previewDigest": before["previewDigest"]})
	if code != 409 {
		t.Fatalf("stale source preview accepted: status=%d; digestEqual=%v", code, before["previewDigest"] == after["previewDigest"])
	}
}

func TestTemplatePresetReviewFencesNewDependentProfile(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "dependent-preview")
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/collections", u.csrf, map[string]any{"id": "collection", "name": "Empty", "sources": []any{}, "steps": []any{}})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = adminTemplateRequest(t, srv, processingTemplate(0, "First {name}"))
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/names/select", u.csrf, map[string]any{"mode": "follow", "targetId": "collection"})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = adminTemplateRequest(t, srv, processingTemplate(1, "Second {name}"))
	if code != 201 {
		t.Fatal(raw)
	}
	code, before, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/preview", u.csrf, map[string]any{})
	if code != 200 {
		t.Fatal(raw)
	}
	p := templateTestProfile("new-dependent", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.CollectionID = "collection"
	p.IR.Endpoints = nil
	p.IR.Groups = nil
	p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/collections_collection/apply", u.csrf, map[string]any{"previewDigest": before["previewDigest"]})
	if code != 409 {
		t.Fatalf("new dependent did not invalidate review: %d %s", code, raw)
	}
}
