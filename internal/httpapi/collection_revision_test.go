package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"testing"

	"routeweaver/internal/domain"
)

func writeOpenedCollection(t *testing.T, owner sessionClient, method, url string, value any, matches ...string) (int, map[string]any, string) {
	t.Helper()
	code, out, body, err := requestOpenedCollection(owner, method, url, value, matches...)
	if err != nil {
		t.Fatal(err)
	}
	return code, out, body
}

// Concurrent callers return failures to their parent rather than calling
// testing.Fatal in a worker and leaving the result channel without an outcome.
func requestOpenedCollection(owner sessionClient, method, url string, value any, matches ...string) (int, map[string]any, string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return 0, nil, "", err
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", owner.csrf)
	for _, match := range matches {
		request.Header.Add("If-Match", match)
	}
	response, err := owner.c.Do(request)
	if err != nil {
		return 0, nil, "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, nil, string(body), err
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return response.StatusCode, nil, string(body), fmt.Errorf("collection response: %s: %w", body, err)
	}
	return response.StatusCode, out, string(body), nil
}

func collectionRevisionToken(t *testing.T, value map[string]any) string {
	t.Helper()
	token, ok := value["revisionToken"].(string)
	if !ok || token == "" {
		t.Fatalf("collection read has no opaque revision token: %v", value)
	}
	return token
}

func TestCollectionOpenedRevisionRejectsStaleEditorAndPreservesSavedRecipe(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-revision")
	collection := domain.Collection{ID: "collection", Name: "Opened collection", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	url := srv.URL + "/api/me/collections/" + collection.ID
	code, opened, body := req(t, owner.c, "POST", srv.URL+"/api/me/collections", owner.csrf, collection)
	if code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	token := collectionRevisionToken(t, opened)
	code, detail, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || detail["revisionToken"] != token {
		t.Fatalf("detail must identify the saved recipe: %d %s", code, body)
	}
	code, _, body = req(t, owner.c, "GET", srv.URL+"/api/me/collections", "", nil)
	var listed []map[string]any
	if code != 200 || json.Unmarshal([]byte(body), &listed) != nil || len(listed) != 1 || listed[0]["revisionToken"] != token {
		t.Fatalf("list must identify the same recipe: %d %s", code, body)
	}
	collection.Name = "Accepted editor"
	collection.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Accepted {name}"}}
	code, saved, body := writeOpenedCollection(t, owner, "PUT", url, collection, token)
	if code != 200 || collectionRevisionToken(t, saved) == token {
		t.Fatalf("matched editor: %d %s", code, body)
	}
	collection.Name = "Stale editor"
	collection.Steps = []domain.ProcessingStep{}
	code, conflict, body := writeOpenedCollection(t, owner, "PUT", url, collection, token)
	if code != 409 || conflict["code"] != "COLLECTION_DRAFT_CHANGED" {
		t.Fatalf("stale editor must not replace a newer recipe: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || !reflect.DeepEqual(current, saved) {
		t.Fatalf("rejected editor changed the saved recipe: %d %s", code, body)
	}
	// A fresh explicit reopening authorizes the changed input, without persisting
	// the response-only token in the collection domain object.
	code, _, body = writeOpenedCollection(t, owner, "PUT", url, collection, collectionRevisionToken(t, current))
	if code != 200 {
		t.Fatalf("fresh editor: %d %s", code, body)
	}
}

func TestCollectionConditionalWritesAreScopedAndFailClosedBeforeResolvingInputs(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-conditional")
	other := inviteClient(t, s, srv, "collection-other")
	collection := domain.Collection{ID: "collection", Name: "Owned collection", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	base := srv.URL + "/api/me/collections"
	url := base + "/" + collection.ID
	code, opened, body := req(t, owner.c, "POST", base, owner.csrf, collection)
	if code != 200 {
		t.Fatal(body)
	}
	token := collectionRevisionToken(t, opened)
	code, foreign, body := req(t, other.c, "POST", base, other.csrf, collection)
	if code != 200 {
		t.Fatal(body)
	}
	foreignToken := collectionRevisionToken(t, foreign)
	otherRecord := collection
	otherRecord.ID = "different-collection"
	code, different, body := req(t, owner.c, "POST", base, owner.csrf, otherRecord)
	if code != 200 {
		t.Fatal(body)
	}
	// Invalid references would fail resolution. Every explicitly invalid header
	// must instead reject the stale editing intent before evaluating that input.
	collection.Sources = []domain.CollectionSource{{SourceID: "missing-source", Steps: []domain.ProcessingStep{}}}
	for _, matches := range [][]string{{""}, {" "}, {"*"}, {"not-a-revision"}, {`"` + token + `"`}, {token + ", " + token}, {token, token}, {foreignToken}, {collectionRevisionToken(t, different)}} {
		for _, method := range []string{"PUT", "POST"} {
			target := url
			if method == "POST" {
				target = base
			}
			code, rejected, body := writeOpenedCollection(t, owner, method, target, collection, matches...)
			if code != 409 || rejected["code"] != "COLLECTION_DRAFT_CHANGED" {
				t.Fatalf("invalid precondition %q on %s: %d %s", matches, method, code, body)
			}
		}
	}
	if code, _, body := writeOpenedCollection(t, owner, "PUT", url, collection, token); code != 400 {
		t.Fatalf("control with current token must validate its missing source: %d %s", code, body)
	}
	collection.Sources = []domain.CollectionSource{}
	if code, rejected, body := writeOpenedCollection(t, other, "PUT", url, collection, token); code != 409 || rejected["code"] != "COLLECTION_DRAFT_CHANGED" {
		t.Fatalf("other tenant accepted owner's revision: %d %s", code, body)
	}
	collection.OwnerID = other.id
	if code, _, body := writeOpenedCollection(t, owner, "PUT", url, collection, token); code != 403 {
		t.Fatalf("owner spoofing: %d %s", code, body)
	}
	collection.OwnerID = ""
	if code, _, body := req(t, owner.c, "PUT", url, "", collection); code != 403 {
		t.Fatalf("CSRF: %d %s", code, body)
	}
	// The response field is not an alternate or persisted body precondition.
	if code, _, body := req(t, owner.c, "PUT", url, owner.csrf, opened); code != 400 {
		t.Fatalf("response token in request body: %d %s", code, body)
	}
	for _, subject := range []struct {
		client sessionClient
		want   map[string]any
	}{{owner, opened}, {other, foreign}} {
		code, current, body := req(t, subject.client.c, "GET", url, "", nil)
		if code != 200 || !reflect.DeepEqual(current, subject.want) {
			t.Fatalf("rejected update changed a tenant's recipe: %d %s", code, body)
		}
	}
	collection.ID = "missing-collection"
	for _, method := range []string{"PUT", "POST"} {
		target := base + "/" + collection.ID
		if method == "POST" {
			target = base
		}
		if code, rejected, body := writeOpenedCollection(t, owner, method, target, collection, token); code != 409 || rejected["code"] != "COLLECTION_DRAFT_CHANGED" {
			t.Fatalf("conditional write recreated missing collection: %d %s", code, body)
		}
	}
	if code, _, body := req(t, owner.c, "GET", base+"/"+collection.ID, "", nil); code != 404 {
		t.Fatalf("failed precondition created collection: %d %s", code, body)
	}
}

func TestCollectionRevisionPreservesLegacyUnconditionalUpserts(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-legacy-api")
	for _, method := range []string{"POST", "PUT"} {
		collection := domain.Collection{ID: "legacy-" + method, Name: "Created", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
		url := srv.URL + "/api/me/collections"
		if method == "PUT" {
			url += "/" + collection.ID
		}
		code, created, body := writeOpenedCollection(t, owner, method, url, collection)
		if code != 200 {
			t.Fatalf("legacy %s create: %d %s", method, code, body)
		}
		collection.Name = "Unconditional replacement"
		code, saved, body := writeOpenedCollection(t, owner, method, url, collection)
		if code != 200 || saved["name"] != collection.Name || collectionRevisionToken(t, saved) == collectionRevisionToken(t, created) {
			t.Fatalf("legacy %s replacement: %d %s", method, code, body)
		}
	}
}

func TestCollectionOpenedRevisionIncludesSourceOrderAndAllProcessingSteps(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-recipe")
	for _, id := range []string{"first", "second"} {
		input := map[string]any{"id": id, "name": id, "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-secret@192.0.2.10:1080#Original", "enabled": true}
		if code, _, body := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, input); code != 200 {
			t.Fatalf("source: %d %s", code, body)
		}
	}
	collection := domain.Collection{
		ID: "collection", Name: "Unchanged name",
		Sources: []domain.CollectionSource{
			{SourceID: "first", Steps: []domain.ProcessingStep{{ID: "source-rename", Enabled: true, Kind: "rename", Template: "Source {name}"}}},
			{SourceID: "second", Steps: []domain.ProcessingStep{}},
		},
		Steps: []domain.ProcessingStep{
			{ID: "rename", Enabled: true, Kind: "rename", Template: "All {name}"},
			{ID: "sort", Enabled: true, Kind: "sort", SortBy: "name"},
		},
	}
	code, current, body := req(t, owner.c, "POST", srv.URL+"/api/me/collections", owner.csrf, collection)
	if code != 200 {
		t.Fatal(body)
	}
	changes := []struct {
		name   string
		change func()
	}{
		{"source order", func() { collection.Sources[0], collection.Sources[1] = collection.Sources[1], collection.Sources[0] }},
		{"source steps", func() { collection.Sources[1].Steps[0].Template = "Changed {name}" }},
		{"aggregate steps", func() { collection.Steps[0].Enabled = false }},
		{"aggregate order", func() { collection.Steps[0], collection.Steps[1] = collection.Steps[1], collection.Steps[0] }},
		{"source selection", func() { collection.Sources = collection.Sources[:1] }},
	}
	url := srv.URL + "/api/me/collections/" + collection.ID
	for _, change := range changes {
		previous := collectionRevisionToken(t, current)
		change.change()
		code, saved, body := writeOpenedCollection(t, owner, "PUT", url, collection, previous)
		if code != 200 || collectionRevisionToken(t, saved) == previous {
			t.Fatalf("%s must change the opened revision: %d %s", change.name, code, body)
		}
		if code, rejected, body := writeOpenedCollection(t, owner, "PUT", url, collection, previous); code != 409 || rejected["code"] != "COLLECTION_DRAFT_CHANGED" {
			t.Fatalf("%s accepted superseded revision: %d %s", change.name, code, body)
		}
		code, current, body = req(t, owner.c, "GET", url, "", nil)
		if code != 200 || !reflect.DeepEqual(current, saved) {
			t.Fatalf("%s changed on rejected replay: %d %s", change.name, code, body)
		}
	}
}

func TestCollectionEditorAndFollowedTemplateCannotOverwriteEachOthersReviewedState(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-template-revision")
	collection := domain.Collection{ID: "collection", Name: "Original", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	url := srv.URL + "/api/me/collections/" + collection.ID
	if code, _, body := req(t, owner.c, "POST", srv.URL+"/api/me/collections", owner.csrf, collection); code != 200 {
		t.Fatal(body)
	}
	if code, _, body := adminTemplateRequest(t, srv, processingTemplate(0, "First {name}")); code != 201 {
		t.Fatal(body)
	}
	if code, _, body := req(t, owner.c, "POST", srv.URL+"/api/me/templates/names/select", owner.csrf, map[string]any{"mode": "follow", "targetId": collection.ID}); code != 200 {
		t.Fatal(body)
	}
	code, opened, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &collection) != nil {
		t.Fatalf("open followed collection: %d %s", code, body)
	}
	if code, _, body := adminTemplateRequest(t, srv, processingTemplate(1, "Second {name}")); code != 201 {
		t.Fatal(body)
	}
	binding := srv.URL + "/api/me/template-bindings/collections_collection"
	code, preview, body := req(t, owner.c, "POST", binding+"/preview", owner.csrf, map[string]any{})
	if code != 200 || preview["compatible"] != true || preview["hasUpdate"] != true {
		t.Fatalf("template review: %d %s", code, body)
	}
	collection.Name = "Local accepted name"
	code, saved, body := writeOpenedCollection(t, owner, "PUT", url, collection, collectionRevisionToken(t, opened))
	if code != 200 {
		t.Fatalf("editor save: %d %s", code, body)
	}
	if code, _, body := req(t, owner.c, "POST", binding+"/apply", owner.csrf, map[string]any{"previewDigest": preview["previewDigest"]}); code != 409 {
		t.Fatalf("template review predating editor save must fail: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || !reflect.DeepEqual(current, saved) {
		t.Fatalf("rejected template changed editor recipe: %d %s", code, body)
	}
	code, preview, body = req(t, owner.c, "POST", binding+"/preview", owner.csrf, map[string]any{})
	if code != 200 || preview["compatible"] != true {
		t.Fatalf("fresh template review: %d %s", code, body)
	}
	if code, _, body := req(t, owner.c, "POST", binding+"/apply", owner.csrf, map[string]any{"previewDigest": preview["previewDigest"]}); code != 200 {
		t.Fatalf("fresh template apply: %d %s", code, body)
	}
	code, applied, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || applied["name"] != "Local accepted name" || collectionRevisionToken(t, applied) == collectionRevisionToken(t, saved) {
		t.Fatalf("template apply must retain name and change recipe revision: %d %s", code, body)
	}
	if steps, ok := applied["steps"].([]any); !ok || len(steps) != 1 || steps[0].(map[string]any)["template"] != "Second {name}" {
		t.Fatalf("template recipe not applied: %s", body)
	}
	collection.Name = "Outdated editor"
	if code, conflict, body := writeOpenedCollection(t, owner, "PUT", url, collection, collectionRevisionToken(t, saved)); code != 409 || conflict["code"] != "COLLECTION_DRAFT_CHANGED" {
		t.Fatalf("stale editor replaced followed template: %d %s", code, body)
	}
	code, current, body = req(t, owner.c, "GET", url, "", nil)
	if code != 200 || !reflect.DeepEqual(current, applied) {
		t.Fatalf("rejected editor changed template recipe: %d %s", code, body)
	}
}

func TestCollectionRevisionWorksForLegacyRecordsAcrossConcurrentStoreHandles(t *testing.T) {
	database := filepath.Join(t.TempDir(), "collections.db")
	s, first := makeServerAt(t, database)
	owner := inviteClient(t, s, first, "collection-durable-revision")
	collection := domain.Collection{ID: "collection", Name: "Legacy collection", OwnerID: owner.id, Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	// Fixture for a restored pre-token record: no stored revision field or schema
	// migration is needed. All edits and outcome assertions use the HTTP seam.
	if err := s.TenantPut(owner.id, "collections", collection.ID, collection); err != nil {
		t.Fatal(err)
	}
	_, second := makeServerAt(t, database)
	path := "/api/me/collections/" + collection.ID
	code, opened, body := req(t, owner.c, "GET", first.URL+path, "", nil)
	if code != 200 {
		t.Fatal(body)
	}
	token := collectionRevisionToken(t, opened)
	code, otherHandle, body := req(t, owner.c, "GET", second.URL+path, "", nil)
	if code != 200 || collectionRevisionToken(t, otherHandle) != token {
		t.Fatalf("store handles disagree on the opened recipe: %d %s", code, body)
	}
	type result struct {
		code  int
		value map[string]any
		body  string
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, base := range []string{first.URL, second.URL} {
		candidate := collection
		candidate.Name = []string{"Concurrent A", "Concurrent B"}[i]
		go func() {
			<-start
			code, value, body, err := requestOpenedCollection(owner, "PUT", base+path, candidate, token)
			results <- result{code, value, body, err}
		}()
	}
	close(start)
	accepted, rejected := 0, 0
	var winner map[string]any
	for range 2 {
		outcome := <-results
		if outcome.err != nil {
			t.Fatalf("concurrent request: %v", outcome.err)
		}
		switch outcome.code {
		case 200:
			accepted++
			winner = outcome.value
		case 409:
			rejected++
			if outcome.value["code"] != "COLLECTION_DRAFT_CHANGED" {
				t.Fatalf("untyped concurrent rejection: %s", outcome.body)
			}
		default:
			t.Fatalf("concurrent update: %d %s", outcome.code, outcome.body)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("expected one accepted writer and one conflict, got %d accepted/%d rejected", accepted, rejected)
	}
	_, restarted := makeServerAt(t, database)
	code, current, body := req(t, owner.c, "GET", restarted.URL+path, "", nil)
	if code != 200 || !reflect.DeepEqual(current, winner) {
		t.Fatalf("durable winner changed after restart: %d %s", code, body)
	}
}
