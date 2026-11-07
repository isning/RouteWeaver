package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
)

func importOpenedRuleFile(t *testing.T, owner sessionClient, base string, revision *string, value any, extraMatches ...string) (int, map[string]any, string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, base+"/api/me/resources/import", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", owner.csrf)
	if revision != nil {
		request.Header.Set("If-Match", *revision)
	}
	for _, match := range extraMatches {
		request.Header.Add("If-Match", match)
	}
	response, err := owner.c.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("import response: %s: %v", body, err)
	}
	return response.StatusCode, out, string(body)
}

func ruleImportInput(id, name, body, policy string) map[string]any {
	return map[string]any{
		"resource":      map[string]any{"id": id, "name": name, "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": policy},
		"contentBase64": base64.StdEncoding.EncodeToString([]byte(body)),
	}
}

func resourceRevisionToken(t *testing.T, value map[string]any) string {
	t.Helper()
	token, ok := value["revisionToken"].(string)
	if !ok || token == "" {
		t.Fatalf("resource read has no opaque revision token: %v", value)
	}
	return token
}

func TestRuleImportOpenedRevisionRejectsStaleReplacement(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "resource-revision")
	first := ruleImportInput("rules", "Opened rules", "payload:\n  - old.example\n", "follow")
	code, opened, body := importOpenedRuleFile(t, owner, srv.URL, nil, first)
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	openedToken := resourceRevisionToken(t, opened)
	code, detail, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || detail["revisionToken"] != openedToken {
		t.Fatalf("detail must describe the accepted record: %d %s", code, body)
	}
	code, _, body = req(t, owner.c, "GET", srv.URL+"/api/me/resources", "", nil)
	var listed []map[string]any
	if code != 200 || json.Unmarshal([]byte(body), &listed) != nil || len(listed) != 1 || listed[0]["revisionToken"] != openedToken {
		t.Fatalf("list must describe the same opened record: %d %s", code, body)
	}
	second := ruleImportInput("rules", "Accepted replacement", "payload:\n  - newer.example\n", "follow")
	code, saved, body := importOpenedRuleFile(t, owner, srv.URL, &openedToken, second)
	if code != 201 {
		t.Fatalf("matched replacement: %d %s", code, body)
	}
	if resourceRevisionToken(t, saved) == openedToken || saved["acceptedVersion"] == opened["acceptedVersion"] {
		t.Fatal("replacement did not produce a new accepted record")
	}
	stale := ruleImportInput("rules", "Stale editor", "payload:\n  - stale.example\n", "pinned")
	code, conflict, body := importOpenedRuleFile(t, owner, srv.URL, &openedToken, stale)
	if code != 409 || conflict["code"] != "RULE_RESOURCE_CHANGED" {
		t.Fatalf("stale replacement must conflict: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || current["name"] != "Accepted replacement" || current["acceptedVersion"] != saved["acceptedVersion"] || current["revisionToken"] != saved["revisionToken"] {
		t.Fatalf("rejected replacement changed the resource: %d %s", code, body)
	}
	// The additive precondition does not silently change legacy upsert callers.
	code, legacy, body := importOpenedRuleFile(t, owner, srv.URL, nil, stale)
	if code != 201 || legacy["name"] != "Stale editor" {
		t.Fatalf("legacy unconditional replacement: %d %s", code, body)
	}
}

func TestRuleImportOpenedRevisionIncludesSameBytesMetadata(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "resource-metadata")
	content := "payload:\n  - unchanged.example\n"
	code, opened, body := importOpenedRuleFile(t, owner, srv.URL, nil, ruleImportInput("rules", "Opened name", content, "follow"))
	if code != 201 {
		t.Fatal(body)
	}
	token := resourceRevisionToken(t, opened)
	code, renamed, body := importOpenedRuleFile(t, owner, srv.URL, &token, ruleImportInput("rules", "Accepted name", content, "pinned"))
	if code != 201 {
		t.Fatalf("same-bytes metadata replacement: %d %s", code, body)
	}
	if renamed["acceptedVersion"] != opened["acceptedVersion"] || renamed["revision"] != opened["revision"] || renamed["digest"] != opened["digest"] {
		t.Fatal("control must retain the same accepted bytes and interpretation")
	}
	if resourceRevisionToken(t, renamed) == token {
		t.Fatal("opened token ignored changed resource metadata")
	}
	code, rejected, body := importOpenedRuleFile(t, owner, srv.URL, &token, ruleImportInput("rules", "Lost update", content, "follow"))
	if code != 409 || rejected["code"] != "RULE_RESOURCE_CHANGED" {
		t.Fatalf("same-bytes stale editor: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || current["name"] != "Accepted name" || current["updatePolicy"] != "pinned" || current["revisionToken"] != renamed["revisionToken"] {
		t.Fatalf("metadata was overwritten: %d %s", code, body)
	}
}

func TestRuleImportConditionalWritesAreOwnerScopedAndFailClosed(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "resource-conditional")
	other := inviteClient(t, s, srv, "resource-other")
	input := ruleImportInput("rules", "Original", "payload:\n  - owned.example\n", "pinned")
	code, opened, body := importOpenedRuleFile(t, owner, srv.URL, nil, input)
	if code != 201 {
		t.Fatal(body)
	}
	token := resourceRevisionToken(t, opened)
	code, foreign, body := importOpenedRuleFile(t, other, srv.URL, nil, input)
	if code != 201 {
		t.Fatal(body)
	}
	foreignToken := resourceRevisionToken(t, foreign)
	for _, invalid := range []string{"", " ", "*", "not-a-revision", token + ", " + token, foreignToken} {
		code, rejected, body := importOpenedRuleFile(t, owner, srv.URL, &invalid, input)
		if code != 409 || rejected["code"] != "RULE_RESOURCE_CHANGED" {
			t.Fatalf("invalid or foreign precondition %q: %d %s", invalid, code, body)
		}
	}
	code, _, body = importOpenedRuleFile(t, owner, srv.URL, &token, input, token)
	if code != 409 {
		t.Fatalf("duplicate preconditions must fail closed: %d %s", code, body)
	}
	code, _, body = importOpenedRuleFile(t, other, srv.URL, &token, input)
	if code != 409 {
		t.Fatalf("owner token authorized another tenant: %d %s", code, body)
	}
	missing := ruleImportInput("missing", "Not created", "payload:\n  - missing.example\n", "pinned")
	code, rejected, body := importOpenedRuleFile(t, owner, srv.URL, &token, missing)
	if code != 409 || rejected["code"] != "RULE_RESOURCE_CHANGED" {
		t.Fatalf("conditional write created a missing target: %d %s", code, body)
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || current["revisionToken"] != token {
		t.Fatalf("rejected conditional writes changed the resource: %d %s", code, body)
	}
	code, _, body = req(t, owner.c, "GET", srv.URL+"/api/me/resources/missing", "", nil)
	if code != 404 {
		t.Fatalf("missing target was created: %d %s", code, body)
	}
}

func TestRuleImportRejectsStaleRevisionBeforeNetworkFetch(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "resource-no-fetch")
	input := ruleImportInput("rules", "Opened", "payload:\n  - owned.example\n", "follow")
	code, opened, body := importOpenedRuleFile(t, owner, srv.URL, nil, input)
	if code != 201 {
		t.Fatal(body)
	}
	staleToken := resourceRevisionToken(t, opened)
	code, accepted, body := importOpenedRuleFile(t, owner, srv.URL, nil, ruleImportInput("rules", "Newer", "payload:\n  - newer.example\n", "follow"))
	if code != 201 {
		t.Fatal(body)
	}
	currentToken := resourceRevisionToken(t, accepted)
	// Control the external DNS boundary, not an internal fetch collaborator.
	// Even the matched-token negative control cannot make a network connection.
	var lookups atomic.Int32
	previousResolver := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		lookups.Add(1)
		return nil, errors.New("test DNS transport unavailable")
	}}
	t.Cleanup(func() { net.DefaultResolver = previousResolver })
	fetch := map[string]any{"resource": map[string]any{"id": "rules", "name": "Fetched", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "follow", "url": "https://rules.example.invalid/file.yaml"}, "fetch": true}
	code, rejected, body := importOpenedRuleFile(t, owner, srv.URL, &staleToken, fetch)
	if code != 409 || rejected["code"] != "RULE_RESOURCE_CHANGED" || lookups.Load() != 0 {
		t.Fatalf("stale precondition reached the network: %d, lookups=%d, %s", code, lookups.Load(), body)
	}
	code, _, body = importOpenedRuleFile(t, owner, srv.URL, &currentToken, fetch)
	if code != 422 || lookups.Load() == 0 {
		t.Fatalf("matched control did not attempt the fetch boundary: %d, lookups=%d, %s", code, lookups.Load(), body)
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || current["revisionToken"] != currentToken {
		t.Fatalf("failed imports changed the accepted resource: %d %s", code, body)
	}
}

func TestRuleImportOpenedRevisionAllowsOnlyOneConcurrentReplacement(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "resource-race")
	code, opened, body := importOpenedRuleFile(t, owner, srv.URL, nil, ruleImportInput("rules", "Original", "payload:\n  - original.example\n", "follow"))
	if code != 201 {
		t.Fatal(body)
	}
	token := resourceRevisionToken(t, opened)
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for _, name := range []string{"First editor", "Second editor"} {
		raw, err := json.Marshal(ruleImportInput("rules", name, "payload:\n  - replacement.example\n", "follow"))
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(http.MethodPost, srv.URL+"/api/me/resources/import", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", owner.csrf)
		request.Header.Set("If-Match", token)
		go func(request *http.Request) {
			<-start
			response, err := owner.c.Do(request)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			results <- result{status: response.StatusCode, body: body, err: err}
		}(request)
	}
	close(start)
	var winner map[string]any
	successes, conflicts := 0, 0
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		var value map[string]any
		if err := json.Unmarshal(got.body, &value); err != nil {
			t.Fatal(err)
		}
		switch got.status {
		case 201:
			successes++
			winner = value
		case 409:
			conflicts++
			if value["code"] != "RULE_RESOURCE_CHANGED" {
				t.Fatalf("unexpected conflict: %s", got.body)
			}
		default:
			t.Fatalf("unexpected replacement response: %d %s", got.status, got.body)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("same opened version allowed %d successes and %d conflicts", successes, conflicts)
	}
	code, current, body := req(t, owner.c, "GET", srv.URL+"/api/me/resources/rules", "", nil)
	if code != 200 || current["name"] != winner["name"] || current["revisionToken"] != winner["revisionToken"] {
		t.Fatalf("accepted winner was overwritten: %d %s", code, body)
	}
}
