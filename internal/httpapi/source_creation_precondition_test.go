package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func sourceCreationRequest(t *testing.T, owner sessionClient, base string, input any, conditions ...string) *http.Request {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, base+"/api/me/sources", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", owner.csrf)
	for _, condition := range conditions {
		request.Header.Add("If-None-Match", condition)
	}
	return request
}

func createSourceWithCondition(t *testing.T, owner sessionClient, base string, input any, conditions ...string) (int, map[string]any, string) {
	t.Helper()
	response, err := owner.c.Do(sourceCreationRequest(t, owner, base, input, conditions...))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal("source creation response was not a JSON object")
	}
	return response.StatusCode, value, string(body)
}

func TestSourceGuardedCreationRetryPreservesNewerInputSnapshotAndCandidate(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-retry")
	original := map[string]any{"id": "retry", "name": "Original source", "kind": "text", "format": "uri-list", "applyMode": "manual", "enabled": true, "content": "socks5://user:original-fixture-secret@one.example:1080#One"}
	status, created, _ := createSourceWithCondition(t, owner, srv.URL, original, "*")
	if status != http.StatusOK {
		t.Fatalf("guarded creation: status %d", status)
	}
	// The original response may be lost. Another editor saves a newer revision
	// before the first editor retries the same stable-ID creation request.
	updated := map[string]any{"id": "retry", "name": "Newer source", "kind": "text", "format": "uri-list", "applyMode": "manual", "enabled": true, "revision": created["revision"], "content": "socks5://user:newer-fixture-secret@one.example:1080#One"}
	status, saved, _ := req(t, owner.c, http.MethodPut, srv.URL+"/api/me/sources/retry", owner.csrf, updated)
	if status != http.StatusOK || saved["candidate"] == nil || saved["revision"] == created["revision"] || sourceSnapshotID(t, saved) != sourceSnapshotID(t, created) {
		t.Fatal("revisioned edit did not retain the accepted snapshot and prepare a new candidate")
	}
	status, privateBefore, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/retry/reveal", "", nil)
	if status != http.StatusOK || privateBefore["content"] != updated["content"] {
		t.Fatal("newer owner-private input was not saved")
	}
	status, candidateBefore, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/retry/candidate/reveal", "", nil)
	if status != http.StatusOK {
		t.Fatalf("candidate reveal: status %d", status)
	}
	status, rejected, body := createSourceWithCondition(t, owner, srv.URL, original, "*")
	if status != http.StatusPreconditionFailed || rejected["code"] != "SOURCE_CREATION_CONFLICT" {
		t.Fatalf("guarded creation retry must fail its precondition: status %d", status)
	}
	for _, secret := range []string{"original-fixture-secret", "newer-fixture-secret", owner.csrf} {
		if strings.Contains(body, secret) {
			t.Fatal("creation conflict disclosed private input or session data")
		}
	}
	status, current, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/retry", "", nil)
	if status != http.StatusOK || !reflect.DeepEqual(current, saved) {
		t.Fatal("rejected creation changed the source summary, revision, snapshot or candidate")
	}
	status, privateAfter, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/retry/reveal", "", nil)
	if status != http.StatusOK || !reflect.DeepEqual(privateAfter, privateBefore) {
		t.Fatal("rejected creation changed the owner-private source")
	}
	status, candidateAfter, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/retry/candidate/reveal", "", nil)
	if status != http.StatusOK || !reflect.DeepEqual(candidateAfter, candidateBefore) {
		t.Fatal("rejected creation changed the private candidate snapshot")
	}
}

func TestSourceGuardedCreationIsOwnerScoped(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-owner")
	other := inviteClient(t, s, srv, "source-create-other")
	input := map[string]any{"id": "same-id", "name": "Owner source", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#One"}
	status, first, _ := createSourceWithCondition(t, owner, srv.URL, input, "*")
	if status != http.StatusOK {
		t.Fatalf("first owner creation: status %d", status)
	}
	input["name"] = "Other source"
	input["content"] = "socks5://two.example:1080#Two"
	status, second, _ := createSourceWithCondition(t, other, srv.URL, input, "*")
	if status != http.StatusOK || second["ownerId"] != other.id || second["revision"] == first["revision"] {
		t.Fatal("another owner's same-ID source blocked or shared guarded creation")
	}
	for _, expected := range []struct {
		owner sessionClient
		value map[string]any
	}{{owner, first}, {other, second}} {
		status, current, _ := req(t, expected.owner.c, http.MethodGet, srv.URL+"/api/me/sources/same-id", "", nil)
		if status != http.StatusOK || !reflect.DeepEqual(current, expected.value) {
			t.Fatal("same-ID sources were not independently retained for their owners")
		}
	}
}

func TestSourceGuardedCreationRejectsMalformedOrDuplicatePreconditions(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-conditions")
	input := map[string]any{"id": "existing", "name": "Existing source", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#One"}
	status, original, _ := createSourceWithCondition(t, owner, srv.URL, input, "*")
	if status != http.StatusOK {
		t.Fatalf("guarded creation: status %d", status)
	}
	conditions := []struct {
		name   string
		values []string
	}{
		{"empty", []string{""}},
		{"blank", []string{" \t "}},
		{"etag", []string{`"fixture-private-etag"`}},
		{"weak-etag", []string{`W/"fixture-private-etag"`}},
		{"unquoted", []string{"fixture-private-etag"}},
		{"non-http-whitespace", []string{"\u00a0*\u00a0"}},
		{"list", []string{"*, *"}},
		{"duplicate", []string{"*", "*"}},
		{"empty-duplicate", []string{"*", ""}},
	}
	for _, condition := range conditions {
		t.Run(condition.name, func(t *testing.T) {
			for _, id := range []string{"existing", "missing"} {
				input := map[string]any{"id": id, "name": "Unaccepted edit", "kind": "text", "enabled": true, "content": "<html>private-unparsed-input</html>"}
				status, rejected, body := createSourceWithCondition(t, owner, srv.URL, input, condition.values...)
				if status != http.StatusBadRequest || rejected["code"] != "SOURCE_CREATION_PRECONDITION_INVALID" {
					t.Fatalf("explicit invalid precondition was not rejected: status %d", status)
				}
				if strings.Contains(body, "fixture-private-etag") || strings.Contains(body, "private-unparsed-input") || strings.Contains(body, owner.csrf) {
					t.Fatal("invalid-precondition response disclosed private request data")
				}
			}
			status, current, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/existing", "", nil)
			if status != http.StatusOK || !reflect.DeepEqual(current, original) {
				t.Fatal("invalid precondition changed an existing source")
			}
			status, _, _ = req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/missing", "", nil)
			if status != http.StatusNotFound {
				t.Fatalf("invalid precondition created a source: status %d", status)
			}
		})
	}
}

func TestSourceGuardDoesNotChangeLegacyPostOrPut(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-legacy")
	input := map[string]any{"id": "legacy", "name": "Created source", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#One"}
	status, created, _ := createSourceWithCondition(t, owner, srv.URL, input, " \t*\t ")
	if status != http.StatusOK {
		t.Fatalf("whitespace-delimited creation precondition: status %d", status)
	}
	input["name"] = "Legacy replacement"
	input["content"] = "socks5://two.example:1080#Two"
	status, replaced, _ := createSourceWithCondition(t, owner, srv.URL, input)
	if status != http.StatusOK || replaced["name"] != input["name"] || replaced["revision"] == created["revision"] {
		t.Fatal("no-header POST no longer supports legacy upserts")
	}
	input["name"] = "Legacy PUT replacement"
	status, updated, _ := req(t, owner.c, http.MethodPut, srv.URL+"/api/me/sources/legacy", owner.csrf, input)
	if status != http.StatusOK || updated["name"] != input["name"] || updated["revision"] == replaced["revision"] {
		t.Fatal("PUT without a revision no longer supports legacy updates")
	}
	status, revealed, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/legacy/reveal", "", nil)
	if status != http.StatusOK || revealed["content"] != input["content"] || revealed["revision"] != updated["revision"] {
		t.Fatal("legacy updates did not retain their saved input")
	}
}

func TestSourceGuardedCreationRejectsExistingBeforeParsingOrFetching(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-no-fetch")
	input := map[string]any{"id": "existing", "name": "Existing source", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#One"}
	status, original, _ := createSourceWithCondition(t, owner, srv.URL, input, "*")
	if status != http.StatusOK {
		t.Fatalf("guarded creation: status %d", status)
	}
	var lookups atomic.Int32
	previousResolver := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		lookups.Add(1)
		return nil, errors.New("test DNS transport unavailable")
	}}
	t.Cleanup(func() { net.DefaultResolver = previousResolver })
	for _, replacement := range []map[string]any{
		{"id": "existing", "name": "Invalid source", "kind": "text", "enabled": true, "content": "<html>private-invalid-input</html>"},
		{"id": "existing", "name": "Fetched source", "kind": "url", "enabled": true, "url": "https://source.example.invalid/feed?token=private-url-token"},
	} {
		status, rejected, body := createSourceWithCondition(t, owner, srv.URL, replacement, "*")
		if status != http.StatusPreconditionFailed || rejected["code"] != "SOURCE_CREATION_CONFLICT" || lookups.Load() != 0 {
			t.Fatalf("existing source reached parsing or the fetch boundary: status %d, lookups %d", status, lookups.Load())
		}
		if strings.Contains(body, "private-invalid-input") || strings.Contains(body, "private-url-token") || strings.Contains(body, owner.csrf) {
			t.Fatal("creation precondition response disclosed private request data")
		}
	}
	status, current, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/existing", "", nil)
	if status != http.StatusOK || !reflect.DeepEqual(current, original) {
		t.Fatal("rejected source parsing or fetch changed the current source")
	}
	// An absent source is a negative control for the same external DNS boundary.
	fetch := map[string]any{"id": "missing", "name": "Fetch control", "kind": "url", "enabled": true, "url": "https://source.example.invalid/feed?token=private-url-token"}
	status, _, body := createSourceWithCondition(t, owner, srv.URL, fetch, "*")
	if status != http.StatusUnprocessableEntity || lookups.Load() == 0 {
		t.Fatalf("absent-source control did not reach the fetch boundary: status %d, lookups %d", status, lookups.Load())
	}
	if strings.Contains(body, "private-url-token") || strings.Contains(body, owner.csrf) {
		t.Fatal("failed fetch response disclosed private request data")
	}
}

func TestSourceGuardedCreationFencesConcurrentCreateAtCommit(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "source-create-race")
	enteredFetch := make(chan struct{})
	releaseFetch := make(chan struct{})
	var entered, released sync.Once
	release := func() { released.Do(func() { close(releaseFetch) }) }
	previousResolver := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		entered.Do(func() { close(enteredFetch) })
		select {
		case <-releaseFetch:
			return nil, errors.New("test DNS transport unavailable")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	t.Cleanup(func() {
		release()
		net.DefaultResolver = previousResolver
	})
	// The first request observes absence, then blocks at an external boundary.
	// A second guarded request can commit before the first resumes, ensuring
	// this checks the atomic absence fence rather than just the initial lookup.
	input := map[string]any{"id": "raced", "name": "Slow creation", "kind": "url", "enabled": true, "url": "https://source.example.invalid/feed?token=private-race-token"}
	request := sourceCreationRequest(t, owner, srv.URL, input, "*")
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 1)
	go func() {
		response, err := owner.c.Do(request)
		if err != nil {
			results <- result{err: err}
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		results <- result{status: response.StatusCode, body: body, err: err}
	}()
	select {
	case <-enteredFetch:
	case <-time.After(10 * time.Second):
		t.Fatal("first guarded creation did not reach the controlled fetch boundary")
	}
	winnerInput := map[string]any{"id": "raced", "name": "Winning creation", "kind": "text", "enabled": true, "content": "socks5://user:winning-fixture-secret@one.example:1080#One"}
	status, winner, _ := createSourceWithCondition(t, owner, srv.URL, winnerInput, "*")
	if status != http.StatusOK {
		t.Fatalf("concurrent guarded creation did not commit: status %d", status)
	}
	release()
	select {
	case got := <-results:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.status != http.StatusConflict {
			t.Fatalf("raced guarded creation did not fail its atomic absence fence: status %d", got.status)
		}
		if bytes.Contains(got.body, []byte("private-race-token")) || bytes.Contains(got.body, []byte("winning-fixture-secret")) || bytes.Contains(got.body, []byte(owner.csrf)) {
			t.Fatal("concurrent creation conflict disclosed private request data")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("raced guarded creation did not complete after the fetch boundary was released")
	}
	status, current, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/raced", "", nil)
	if status != http.StatusOK || !reflect.DeepEqual(current, winner) {
		t.Fatal("concurrent creation overwrote the accepted winner")
	}
	status, private, _ := req(t, owner.c, http.MethodGet, srv.URL+"/api/me/sources/raced/reveal", "", nil)
	if status != http.StatusOK || private["content"] != winnerInput["content"] || private["url"] != nil {
		t.Fatal("concurrent creation replaced the winning source input")
	}
}
