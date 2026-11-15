package httpapi_test

import (
	"fmt"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestActionsCompareBoundedCollectionsAndMissingReferences(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "actions-collection")
	other := inviteClient(t, s, srv, "actions-foreign")
	p := templateTestProfile("collection-profile", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.CollectionID = "collection"
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "node"}
	endpoint := p.IR.Endpoints[0]
	endpoint.OwnerID = owner.id
	source := httpapi.Source{ID: "source", Name: "Source", OwnerID: owner.id, Enabled: true, Snapshot: &domain.SourceSnapshot{SourceID: "source", SnapshotID: "accepted", OwnerID: owner.id, Endpoints: []domain.ClientEndpoint{endpoint}}}
	collection := domain.Collection{ID: "collection", Name: "Collection", OwnerID: owner.id, Sources: []domain.CollectionSource{{SourceID: "source"}}}
	if err := s.TenantPut(owner.id, "sources", source.ID, source); err != nil {
		t.Fatal(err)
	}
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "phone", "name": "Phone", "profileId": p.ID, "target": p.Target})
	if code != 201 {
		t.Fatal(raw)
	}
	read := func(kind string, partial bool) {
		t.Helper()
		code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
		if code != 200 || v["partial"] != partial {
			t.Fatalf("collection summary: %d %s", code, raw)
		}
		unchecked := v["uncheckedOutputs"].([]any)
		if partial {
			if len(unchecked) != 1 || unchecked[0].(map[string]any)["id"] != "phone" || unchecked[0].(map[string]any)["revision"] == "" {
				t.Fatalf("missing explicit-check identity: %s", raw)
			}
		} else if len(unchecked) != 0 {
			t.Fatalf("completed check marked unchecked: %s", raw)
		}
		items := v["items"].([]any)
		if kind == "" {
			if len(items) != 0 {
				t.Fatal(raw)
			}
		} else if len(items) != 1 || items[0].(map[string]any)["kind"] != kind {
			t.Fatal(raw)
		}
	}
	read("", false)
	source.Snapshot.Endpoints[0].Connection.Password = "new-source-password"
	if err := s.TenantPut(owner.id, "sources", source.ID, source); err != nil {
		t.Fatal(err)
	}
	read("output-changed", false)
	// Removing a selected endpoint reports the existing typed repair failure.
	source.Snapshot.Endpoints = nil
	if err := s.TenantPut(owner.id, "sources", source.ID, source); err != nil {
		t.Fatal(err)
	}
	read("output-reference-missing", false)
	// A same-ID foreign collection cannot supply this owner's inputs.
	if err := s.TenantPut(other.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	if err := s.TenantRemove(owner.id, "collections", collection.ID); err != nil {
		t.Fatal(err)
	}
	read("", true)
	for i := 0; i < 33; i++ {
		collection.Steps = append(collection.Steps, domain.ProcessingStep{ID: fmt.Sprintf("step-%d", i), Kind: "sort", SortBy: "name"})
	}
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	read("", true)
	// Count boundaries are checked before the conversion pipeline builds stages.
	collection.Steps = nil
	collection.Sources = nil
	for i := 0; i < 16; i++ {
		id := fmt.Sprintf("source-%d", i)
		endpoints := []domain.ClientEndpoint{}
		for j := 0; j < 16; j++ {
			e := endpoint
			if i != 0 || j != 0 {
				e.ID = fmt.Sprintf("node-%d-%d", i, j)
			}
			endpoints = append(endpoints, e)
		}
		entry := httpapi.Source{ID: id, OwnerID: owner.id, Enabled: true, Snapshot: &domain.SourceSnapshot{SourceID: id, SnapshotID: "accepted", OwnerID: owner.id, Endpoints: endpoints}}
		if err := s.TenantPut(owner.id, "sources", id, entry); err != nil {
			t.Fatal(err)
		}
		collection.Sources = append(collection.Sources, domain.CollectionSource{SourceID: id})
	}
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	read("output-changed", false) // exactly 16 sources / 256 endpoints
	collection.Sources = append(collection.Sources, domain.CollectionSource{SourceID: "source"})
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	read("", true) // 17th source, even if empty
	collection.Sources = collection.Sources[:16]
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	var first httpapi.Source
	if err := s.TenantGet(owner.id, "sources", "source-0", &first); err != nil {
		t.Fatal(err)
	}
	extra := endpoint
	extra.ID = "node-extra"
	first.Snapshot.Endpoints = append(first.Snapshot.Endpoints, extra)
	if err := s.TenantPut(owner.id, "sources", "source-0", first); err != nil {
		t.Fatal(err)
	}
	read("", true) // 257 endpoints
	first.Snapshot.Endpoints = first.Snapshot.Endpoints[:16]
	first.Snapshot.Endpoints[0].Name = strings.Repeat("n", 161)
	if err := s.TenantPut(owner.id, "sources", "source-0", first); err != nil {
		t.Fatal(err)
	}
	read("", true) // substitution input rejected before rename expansion
	first.Snapshot.Endpoints[0].Name = endpoint.Name
	if err := s.TenantPut(owner.id, "sources", "source-0", first); err != nil {
		t.Fatal(err)
	}
	collection.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: strings.Repeat("{name}", 1000)}}
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	read("", true) // template rejected before substitution allocation
}
