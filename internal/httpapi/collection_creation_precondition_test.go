package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func createCollectionWithCondition(t *testing.T, owner sessionClient, base string, value any, conditions ...string) (int, map[string]any, string) {
	t.Helper()
	code, out, body, err := requestCollectionCreation(owner, "POST", base+"/api/me/collections", value, conditions...)
	if err != nil {
		t.Fatal(err)
	}
	return code, out, body
}

func requestCollectionCreation(owner sessionClient, method, url string, value any, conditions ...string) (int, map[string]any, string, error) {
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
	for _, condition := range conditions {
		request.Header.Add("If-None-Match", condition)
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

func TestCollectionGuardedCreationRetryPreservesNewerRecipe(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-retry")
	original := domain.Collection{ID: "retry", Name: "Original", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	code, created, body := createCollectionWithCondition(t, owner, srv.URL, original, "*")
	if code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	updated := original
	updated.Name = "Newer recipe"
	updated.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Newer {name}"}}
	url := srv.URL + "/api/me/collections/retry"
	code, saved, body := writeOpenedCollection(t, owner, "PUT", url, updated, collectionRevisionToken(t, created))
	if code != 200 {
		t.Fatalf("newer edit: %d %s", code, body)
	}
	// The successful original response was lost; replay must not erase the edit.
	code, rejected, body := createCollectionWithCondition(t, owner, srv.URL, original, "*")
	if code != 412 || rejected["code"] != "COLLECTION_CREATION_CONFLICT" {
		t.Fatalf("creation retry: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 || !reflect.DeepEqual(current, saved) {
		t.Fatalf("retry changed saved recipe: %d %s", code, body)
	}
}

func TestCollectionGuardedCreationIsOwnerScopedAndRejectsBeforeResolvingSources(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-owner")
	other := inviteClient(t, s, srv, "collection-create-other")
	input := domain.Collection{ID: "shared", Name: "Owner recipe", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	code, first, body := createCollectionWithCondition(t, owner, srv.URL, input, "*")
	if code != 200 {
		t.Fatalf("owner create: %d %s", code, body)
	}
	input.Name = "Other recipe"
	code, second, body := createCollectionWithCondition(t, other, srv.URL, input, "*")
	if code != 200 || second["ownerId"] != other.id {
		t.Fatalf("other owner same ID: %d %s", code, body)
	}
	input.Sources = []domain.CollectionSource{{SourceID: "missing-private-source", Steps: []domain.ProcessingStep{}}}
	code, rejected, body := createCollectionWithCondition(t, owner, srv.URL, input, "*")
	if code != 412 || rejected["code"] != "COLLECTION_CREATION_CONFLICT" {
		t.Fatalf("existing ID reached source resolution: %d %s", code, body)
	}
	if strings.Contains(body, "missing-private-source") || strings.Contains(body, owner.csrf) {
		t.Fatal("conflict disclosed request data")
	}
	input.ID = "absent"
	if code, _, body := createCollectionWithCondition(t, owner, srv.URL, input, "*"); code != 400 {
		t.Fatalf("absent-ID control must resolve missing source: %d %s", code, body)
	}
	for _, expected := range []struct {
		owner sessionClient
		value map[string]any
	}{{owner, first}, {other, second}} {
		code, current, body := req(t, expected.owner.c, "GET", srv.URL+"/api/me/collections/shared", "", nil)
		if code != 200 || !reflect.DeepEqual(current, expected.value) {
			t.Fatalf("tenant recipe changed: %d %s", code, body)
		}
	}
}

func TestCollectionGuardedCreationRejectsMalformedPreconditions(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-conditions")
	input := domain.Collection{ID: "existing", Name: "Existing", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	code, original, body := createCollectionWithCondition(t, owner, srv.URL, input, "*")
	if code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	for _, conditions := range [][]string{{""}, {" \t "}, {`"private-etag"`}, {`W/"private-etag"`}, {"private-etag"}, {"\u00a0*\u00a0"}, {"*, *"}, {"*", "*"}, {"*", ""}} {
		for _, id := range []string{"existing", "missing"} {
			input.ID = id
			code, rejected, body := createCollectionWithCondition(t, owner, srv.URL, input, conditions...)
			if code != 400 || rejected["code"] != "COLLECTION_CREATION_PRECONDITION_INVALID" {
				t.Fatalf("invalid conditions %q: %d %s", conditions, code, body)
			}
			if strings.Contains(body, "private-etag") || strings.Contains(body, owner.csrf) {
				t.Fatal("invalid precondition disclosed request data")
			}
		}
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/collections/existing", "", nil)
	if code != 200 || !reflect.DeepEqual(current, original) {
		t.Fatalf("invalid precondition changed existing recipe: %d %s", code, body)
	}
	if code, _, body := req(t, owner.c, "GET", srv.URL+"/api/me/collections/missing", "", nil); code != 404 {
		t.Fatalf("invalid precondition created recipe: %d %s", code, body)
	}
}

func TestCollectionCreationGuardPreservesLegacyAndOpenedRevisionWrites(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-legacy")
	input := domain.Collection{ID: "legacy", Name: "Original", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	code, original, body := createCollectionWithCondition(t, owner, srv.URL, input, " \t*\t ")
	if code != 200 {
		t.Fatalf("whitespace wildcard: %d %s", code, body)
	}
	input.Name = "Headerless POST"
	code, saved, body := createCollectionWithCondition(t, owner, srv.URL, input)
	if code != 200 || saved["name"] != input.Name {
		t.Fatalf("legacy POST: %d %s", code, body)
	}
	url := srv.URL + "/api/me/collections/legacy"
	input.Name = "Headerless PUT"
	code, saved, body = req(t, owner.c, "PUT", url, owner.csrf, input)
	if code != 200 || saved["name"] != input.Name {
		t.Fatalf("legacy PUT: %d %s", code, body)
	}
	code, conflict, body := writeOpenedCollection(t, owner, "PUT", url, input, collectionRevisionToken(t, original))
	if code != 409 || conflict["code"] != "COLLECTION_DRAFT_CHANGED" {
		t.Fatalf("stale If-Match: %d %s", code, body)
	}
	input.Name = "Current If-Match"
	code, saved, body = writeOpenedCollection(t, owner, "PUT", url, input, collectionRevisionToken(t, saved))
	if code != 200 || saved["name"] != input.Name {
		t.Fatalf("current If-Match: %d %s", code, body)
	}
	input.ID = "legacy-put-create"
	if code, _, body := req(t, owner.c, "PUT", srv.URL+"/api/me/collections/"+input.ID, owner.csrf, input); code != 200 {
		t.Fatalf("legacy PUT creation: %d %s", code, body)
	}
}

func TestCollectionGuardedCreationDoesNotBypassRequestSecurity(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-security")
	input := domain.Collection{ID: "secure", Name: "Secure", Sources: []domain.CollectionSource{}, Steps: []domain.ProcessingStep{}}
	for _, test := range []struct {
		client sessionClient
		input  any
		code   int
	}{
		{sessionClient{c: http.DefaultClient}, input, 401},
		{sessionClient{c: owner.c}, input, 403},
		{owner, domain.Collection{ID: "secure", OwnerID: "another-owner"}, 403},
		{owner, map[string]any{"id": "secure", "name": "Secure", "unknown": true}, 400},
	} {
		code, _, body := createCollectionWithCondition(t, test.client, srv.URL, test.input, "*")
		if code != test.code {
			t.Fatalf("guarded request security: want %d, got %d %s", test.code, code, body)
		}
	}
	if code, _, body := req(t, owner.c, "GET", srv.URL+"/api/me/collections/secure", "", nil); code != 404 {
		t.Fatalf("rejected request persisted recipe: %d %s", code, body)
	}
}

func TestCollectionGuardedCreationAcrossConcurrentStoreHandlesHasOneDurableWinner(t *testing.T) {
	database := filepath.Join(t.TempDir(), "collections.db")
	s, first := makeServerAt(t, database)
	owner := inviteClient(t, s, first, "collection-create-race")
	for _, id := range []string{"first", "second"} {
		input := map[string]any{"id": id, "name": id, "kind": "text", "enabled": true, "content": "socks5://" + id + ".example:1080#" + id}
		if code, _, body := req(t, owner.c, "POST", first.URL+"/api/me/sources", owner.csrf, input); code != 200 {
			t.Fatalf("source fixture: %d %s", code, body)
		}
	}
	_, second := makeServerAt(t, database)
	type result struct {
		code  int
		value map[string]any
		body  string
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, base := range []string{first.URL, second.URL} {
		candidate := domain.Collection{
			ID: "raced", Name: []string{"First recipe", "Second recipe"}[i],
			Sources: []domain.CollectionSource{
				{SourceID: []string{"first", "second"}[i], Steps: []domain.ProcessingStep{{ID: "source-rename", Enabled: true, Kind: "rename", Template: "Source {name}"}}},
				{SourceID: []string{"second", "first"}[i], Steps: []domain.ProcessingStep{}},
			},
			Steps: []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: []string{"First {name}", "Second {name}"}[i]}, {ID: "sort", Enabled: true, Kind: "sort", SortBy: "name"}},
		}
		go func() {
			<-start
			code, value, body, err := requestCollectionCreation(owner, "POST", base+"/api/me/collections", candidate, "*")
			results <- result{code, value, body, err}
		}()
	}
	close(start)
	accepted, rejected := 0, 0
	var winner map[string]any
	for range 2 {
		outcome := <-results
		if outcome.err != nil {
			t.Fatal(outcome.err)
		}
		switch outcome.code {
		case 200:
			accepted++
			winner = outcome.value
		case 412:
			rejected++
			if outcome.value["code"] != "COLLECTION_CREATION_CONFLICT" {
				t.Fatalf("untyped existing-ID rejection: %s", outcome.body)
			}
		case 409:
			rejected++
			if outcome.value["code"] != "COLLECTION_DRAFT_CHANGED" {
				t.Fatalf("untyped atomic race rejection: %s", outcome.body)
			}
		default:
			t.Fatalf("concurrent create: %d %s", outcome.code, outcome.body)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("want one winner and one rejection, got %d/%d", accepted, rejected)
	}
	_, reopened := makeServerAt(t, database)
	for _, base := range []string{first.URL, second.URL, reopened.URL} {
		code, current, body := req(t, owner.c, "GET", base+"/api/me/collections/raced", "", nil)
		if code != 200 || !reflect.DeepEqual(current, winner) {
			t.Fatalf("complete durable winning recipe changed: %d %s", code, body)
		}
	}
}

func TestCollectionGuardedRetryPreservesSourcesBindingsAndDependentPublication(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "collection-create-dependent")
	call := func(method, path string, input any, want int) (map[string]any, string) {
		t.Helper()
		code, value, body := req(t, owner.c, method, srv.URL+"/api/me/"+path, owner.csrf, input)
		if code != want {
			t.Fatalf("%s %s: %d %s", method, path, code, body)
		}
		return value, body
	}
	for _, id := range []string{"first", "second"} {
		call("POST", "sources", map[string]any{"id": id, "name": id, "kind": "text", "format": "uri-list", "content": "socks5://" + id + ".example:1080#" + id, "enabled": true}, 200)
	}
	original := domain.Collection{ID: "recipe", Name: "Original", Sources: []domain.CollectionSource{{SourceID: "first", Steps: []domain.ProcessingStep{}}, {SourceID: "second", Steps: []domain.ProcessingStep{}}}, Steps: []domain.ProcessingStep{}}
	if code, _, body := createCollectionWithCondition(t, owner, srv.URL, original, "*"); code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	if code, _, body := adminTemplateRequest(t, srv, processingTemplate(0, "Template {name}")); code != 201 {
		t.Fatalf("template: %d %s", code, body)
	}
	call("POST", "templates/names/select", map[string]any{"mode": "follow", "targetId": original.ID}, 200)
	opened, body := call("GET", "collections/recipe", nil, 200)
	var newer domain.Collection
	if err := json.Unmarshal([]byte(body), &newer); err != nil {
		t.Fatal(err)
	}
	newer.Name = "Accepted recipe"
	newer.Sources[0], newer.Sources[1] = newer.Sources[1], newer.Sources[0]
	newer.Sources[0].Steps = []domain.ProcessingStep{{ID: "source-rename", Enabled: true, Kind: "rename", Template: "Source {name}"}}
	newer.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Accepted {name}"}, {ID: "sort", Enabled: true, Kind: "sort", SortBy: "name"}}
	code, saved, body := writeOpenedCollection(t, owner, "PUT", srv.URL+"/api/me/collections/recipe", newer, collectionRevisionToken(t, opened))
	if code != 200 {
		t.Fatalf("newer recipe: %d %s", code, body)
	}
	profile := map[string]any{"id": "dependent", "name": "Dependent", "collectionId": "recipe", "target": map[string]string{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "defaultAction": map[string]string{"kind": "direct"}, "runtime": map[string]any{"mixedPort": 7890}}}
	call("POST", "profiles", profile, 200)
	output, _ := call("POST", "outputs", map[string]any{"id": "feed", "name": "Feed", "profileId": "dependent"}, 201)
	feedPath, ok := output["feedPath"].(string)
	if !ok || feedPath == "" {
		t.Fatal("published output has no feed path")
	}
	feedCode, _, feedBefore := req(t, http.DefaultClient, "GET", srv.URL+feedPath, "", nil)
	if feedCode != 200 || !strings.Contains(feedBefore, "Accepted") {
		t.Fatalf("fixture feed did not publish the newer recipe: %d", feedCode)
	}
	paths := []string{"collections/recipe", "sources/first/reveal", "sources/second/reveal", "template-bindings", "profiles/dependent/reveal", "outputs", "outputs/feed/status"}
	before := map[string]string{}
	for _, path := range paths {
		_, before[path] = call("GET", path, nil, 200)
	}
	code, rejected, body := createCollectionWithCondition(t, owner, srv.URL, original, "*")
	if code != 412 || rejected["code"] != "COLLECTION_CREATION_CONFLICT" {
		t.Fatalf("retry: %d %s", code, body)
	}
	current, _ := call("GET", "collections/recipe", nil, 200)
	if !reflect.DeepEqual(current, saved) {
		t.Fatal("retry changed complete source order, per-source steps or aggregate recipe")
	}
	for _, path := range paths {
		_, after := call("GET", path, nil, 200)
		if after != before[path] {
			t.Fatalf("rejected retry changed %s", path)
		}
	}
	feedCode, _, feedAfter := req(t, http.DefaultClient, "GET", srv.URL+feedPath, "", nil)
	if feedCode != 200 || feedAfter != feedBefore {
		t.Fatal("rejected retry changed frozen dependent publication")
	}
}
