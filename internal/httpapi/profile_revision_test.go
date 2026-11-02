package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"testing"

	"routeweaver/internal/render"
)

// The revision is the one the editor opened, never fetched again on submission.
func putOpenedProfile(t *testing.T, owner sessionClient, url, revision string, value any) (int, map[string]any, string) {
	t.Helper()
	raw, _ := json.Marshal(value)
	request, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-CSRF-Token", owner.csrf)
	request.Header.Set("If-Match", revision)
	response, err := owner.c.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	var out map[string]any
	_ = json.Unmarshal(body, &out)
	return response.StatusCode, out, string(body)
}

func TestProfileOpenedRevisionRejectsStaleWriteAndPreservesPublishedFeed(t *testing.T) {
	database := filepath.Join(t.TempDir(), "profiles.db")
	s, srv := makeServerAt(t, database)
	owner := inviteClient(t, s, srv, "profile-revision")
	profile := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"tcp-concurrent":true}`)
	url := srv.URL + "/api/me/profiles/" + profile.ID
	if code, _, body := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile); code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	code, output, body := req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "frozen", "name": "Published", "profileId": profile.ID})
	if code != 201 {
		t.Fatalf("publish: %d %s", code, body)
	}
	feed := output["feedPath"].(string)
	code, _, before := req(t, http.DefaultClient, "GET", srv.URL+feed, "", nil)
	if code != 200 {
		t.Fatalf("feed: %d %s", code, before)
	}
	_, first, _ := req(t, owner.c, "GET", url+"/reveal", "", nil)
	_, second, _ := req(t, owner.c, "GET", url+"/reveal", "", nil)
	firstToken, _ := first["revisionToken"].(string)
	secondToken, _ := second["revisionToken"].(string)
	profile.Name = "Editor A committed"
	code, saved, body := putOpenedProfile(t, owner, url, firstToken, profile)
	if code != 200 {
		t.Fatalf("first writer: %d %s", code, body)
	}
	profile.Name = "Editor B submitted draft"
	code, conflict, body := putOpenedProfile(t, owner, url, secondToken, profile)
	if code != 409 {
		t.Fatalf("stale editor must fail, not overwrite the committed draft: %d %s", code, body)
	}
	if conflict["code"] != "PROFILE_DRAFT_CHANGED" {
		t.Fatalf("untyped conflict: %s", body)
	}
	if firstToken == "" || firstToken != secondToken || saved["revisionToken"] == firstToken {
		t.Fatal("opened and saved revisions must identify exact saved drafts")
	}
	// Reopen a separate durable store/server; the accepted draft and published bytes survive.
	_, restarted := makeServerAt(t, database)
	code, current, body := req(t, owner.c, "GET", restarted.URL+"/api/me/profiles/"+profile.ID, "", nil)
	if code != 200 || current["name"] != "Editor A committed" {
		t.Fatalf("durable draft: %d %s", code, body)
	}
	code, _, after := req(t, http.DefaultClient, "GET", restarted.URL+feed, "", nil)
	if code != 200 || before != after {
		t.Fatalf("draft edit altered published feed: %d %s", code, after)
	}
}

func TestProfileWritesRequireOpenedRevisionWithoutLegacyUpsertBypass(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "profile-preconditions")
	other := inviteClient(t, s, srv, "profile-other")
	profile := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"tcp-concurrent":true}`)
	url := srv.URL + "/api/me/profiles/" + profile.ID
	code, created, body := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile)
	if code != 200 {
		t.Fatalf("create: %d %s", code, body)
	}
	token, _ := created["revisionToken"].(string)
	if token == "" {
		t.Fatal("create did not return an opened revision")
	}
	_, summary, _ := req(t, owner.c, "GET", url, "", nil)
	_, reveal, _ := req(t, owner.c, "GET", url+"/reveal", "", nil)
	if summary["revisionToken"] != token || reveal["revisionToken"] != token {
		t.Fatal("summaries and reveal must describe the same private record revision")
	}
	profile.Name = "Unguarded overwrite"
	for _, method := range []string{"POST", "PUT"} {
		target := url
		if method == "POST" {
			target = srv.URL + "/api/me/profiles"
		}
		code, response, body := req(t, owner.c, method, target, owner.csrf, profile)
		if code != 409 || response["code"] != "PROFILE_DRAFT_CHANGED" {
			t.Fatalf("unguarded %s: %d %s", method, code, body)
		}
	}
	if code, _, body := putOpenedProfile(t, owner, url, "*", profile); code != 409 {
		t.Fatalf("wildcard must not bypass comparison: %d %s", code, body)
	}
	// A JSON token is not an alternate, accidentally persisted precondition.
	reveal["name"] = "Token in JSON"
	if code, _, body := req(t, owner.c, "PUT", url, owner.csrf, reveal); code != 400 {
		t.Fatalf("body token: %d %s", code, body)
	}
	if code, _, body := req(t, owner.c, "PUT", url, "", profile); code != 403 {
		t.Fatalf("CSRF: %d %s", code, body)
	}
	if code, _, body := putOpenedProfile(t, other, url, token, profile); code != 404 {
		t.Fatalf("cross-tenant update: %d %s", code, body)
	}
	if code, _, body := req(t, other.c, "POST", srv.URL+"/api/me/profiles", other.csrf, profile); code != 200 {
		t.Fatalf("tenant-local create: %d %s", code, body)
	}
	if code, _, body := putOpenedProfile(t, other, url, token, profile); code != 409 {
		t.Fatalf("other tenant token accepted: %d %s", code, body)
	}
	_, latest, _ := req(t, owner.c, "GET", url, "", nil)
	if latest["name"] != created["name"] || latest["revisionToken"] != token {
		t.Fatal("rejected writer changed the draft")
	}
	// Clones retain intent but create a distinct record without an update token.
	profile.ID = "profile-copy"
	if code, _, body := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, profile); code != 200 {
		t.Fatalf("clone create: %d %s", code, body)
	}
}

func TestProfileRevisionWorksForLegacyStoredDraftAndConcurrentStoreHandles(t *testing.T) {
	database := filepath.Join(t.TempDir(), "legacy.db")
	s, first := makeServerAt(t, database)
	owner := inviteClient(t, s, first, "profile-legacy")
	profile := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
	profile.IR.OwnerID = owner.id
	// Represents a profile restored from a pre-token backup: no token or schema field.
	if err := s.TenantPut(owner.id, "profiles", profile.ID, profile); err != nil {
		t.Fatal(err)
	}
	_, second := makeServerAt(t, database)
	_, opened, _ := req(t, owner.c, "GET", first.URL+"/api/me/profiles/"+profile.ID+"/reveal", "", nil)
	token, _ := opened["revisionToken"].(string)
	if token == "" {
		t.Fatal("legacy draft has no read token")
	}
	type result struct {
		code int
		body string
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, base := range []string{first.URL, second.URL} {
		candidate := profile
		candidate.Name = []string{"Concurrent A", "Concurrent B"}[i]
		go func() {
			<-start
			code, _, body := putOpenedProfile(t, owner, base+"/api/me/profiles/"+profile.ID, token, candidate)
			results <- result{code, body}
		}()
	}
	close(start)
	accepted, rejected := 0, 0
	for range 2 {
		outcome := <-results
		switch outcome.code {
		case 200:
			accepted++
		case 409:
			rejected++
		default:
			t.Fatalf("concurrent update: %d %s", outcome.code, outcome.body)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("atomic compare must accept exactly one writer, got %d accepted/%d rejected", accepted, rejected)
	}
}
