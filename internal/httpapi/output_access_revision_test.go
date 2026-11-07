package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/render"
)

func mutateOpenedOutput(t *testing.T, owner sessionClient, url string, matches ...string) (int, map[string]any, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-CSRF-Token", owner.csrf)
	for _, match := range matches {
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
		t.Fatal("response is not valid JSON")
	}
	return response.StatusCode, out, string(body)
}

func outputAccessRevision(t *testing.T, view map[string]any) string {
	t.Helper()
	token, ok := view["accessRevision"].(string)
	if !ok || token == "" {
		t.Fatal("output has no opaque access revision")
	}
	return token
}

func createAccessRevisionOutput(t *testing.T, owner sessionClient, base, id string) map[string]any {
	t.Helper()
	profile := templateTestProfile(id, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	code, _, _ := req(t, owner.c, "POST", base+"/api/me/profiles", owner.csrf, profile)
	if code != 200 {
		t.Fatalf("fixture request failed: status=%d", code)
	}
	code, output, _ := req(t, owner.c, "POST", base+"/api/me/outputs", owner.csrf, map[string]string{"id": id, "name": id, "profileId": id})
	if code != 201 {
		t.Fatalf("fixture request failed: status=%d", code)
	}
	return output
}

func assertAccessRevisionFeed(t *testing.T, base string, output map[string]any, want int) {
	t.Helper()
	for _, key := range []string{"feedPath", "bundlePath"} {
		response, err := http.Get(base + output[key].(string))
		if err != nil {
			t.Fatalf("%s request failed", key)
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("%s status=%d, want %d", key, response.StatusCode, want)
		}
	}
}

func assertOutputAccessChanged(t *testing.T, code int, out map[string]any, raw string) {
	t.Helper()
	if code != 409 || out["code"] != "OUTPUT_ACCESS_CHANGED" {
		t.Fatalf("expected safe stale-action conflict: status=%d", code)
	}
	for _, secret := range []string{"feedPath", "/feed/", "tokenDigest", "secret-password", "rw1_"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("conflict leaked prohibited pattern %q", secret)
		}
	}
}

func TestOutputAccessRevisionStaleRotationPreservesNewerLinks(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "opened-output")
	opened := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	token := outputAccessRevision(t, opened)
	code, detail, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/phone/status", "", nil)
	if code != 200 || detail["accessRevision"] != token {
		t.Fatalf("opened detail: status=%d", code)
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	var listed []map[string]any
	if code != 200 || json.Unmarshal([]byte(raw), &listed) != nil || len(listed) != 1 || listed[0]["accessRevision"] != token {
		t.Fatalf("opened list: status=%d", code)
	}
	code, rotated, raw := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/rotate", token)
	if code != 200 || outputAccessRevision(t, rotated) == token {
		t.Fatalf("fresh rotation: status=%d", code)
	}
	assertAccessRevisionFeed(t, srv.URL, opened, 404)
	assertAccessRevisionFeed(t, srv.URL, rotated, 200)
	// A delayed second confirmation (or retry) must not invalidate the newer link.
	code, conflict, raw := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/rotate", token)
	assertOutputAccessChanged(t, code, conflict, raw)
	assertAccessRevisionFeed(t, srv.URL, rotated, 200)
}

func TestOutputAccessRevisionStaleRevokePreservesRepublishedLinks(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "restored-output")
	opened := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	old := outputAccessRevision(t, opened)
	code, revoked, raw := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/revoke", old)
	if code != 200 || outputAccessRevision(t, revoked) == old {
		t.Fatalf("fresh revoke: status=%d", code)
	}
	assertAccessRevisionFeed(t, srv.URL, opened, 404)
	code, restored, raw := req(t, owner.c, "POST", srv.URL+"/api/me/outputs/phone/publish", owner.csrf, map[string]any{})
	if code != 200 || outputAccessRevision(t, restored) == old || outputAccessRevision(t, restored) == outputAccessRevision(t, revoked) {
		t.Fatalf("republish: status=%d", code)
	}
	code, access, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/phone/access", "", nil)
	if code != 200 {
		t.Fatalf("restored access: status=%d", code)
	}
	code, conflict, raw := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/revoke", old)
	assertOutputAccessChanged(t, code, conflict, raw)
	assertAccessRevisionFeed(t, srv.URL, access, 200)
	code, _, raw = mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/revoke", outputAccessRevision(t, restored))
	if code != 200 {
		t.Fatalf("fresh restored revoke: status=%d", code)
	}
	assertAccessRevisionFeed(t, srv.URL, access, 404)
}

func TestOutputAccessRevisionRejectsInvalidOrForeignPreconditions(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "revision-owner")
	other := inviteClient(t, s, srv, "revision-other")
	opened := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	sibling := createAccessRevisionOutput(t, owner, srv.URL, "laptop")
	foreign := createAccessRevisionOutput(t, other, srv.URL, "phone")
	token := outputAccessRevision(t, opened)
	for _, operation := range []string{"rotate", "revoke"} {
		for _, scenario := range []struct {
			name    string
			matches []string
		}{
			{"empty", []string{""}},
			{"malformed", []string{"not-a-revision"}},
			{"wildcard", []string{"*"}},
			{"combined", []string{token + ", " + token}},
			{"duplicate", []string{token, token}},
			{"sibling", []string{outputAccessRevision(t, sibling)}},
			{"other owner", []string{outputAccessRevision(t, foreign)}},
		} {
			t.Run(operation+"/"+scenario.name, func(t *testing.T) {
				code, out, raw := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/"+operation, scenario.matches...)
				assertOutputAccessChanged(t, code, out, raw)
				assertAccessRevisionFeed(t, srv.URL, opened, 200)
			})
		}
		// Knowing the other owner's revision cannot bypass tenant lookup.
		code, _, raw := mutateOpenedOutput(t, other, srv.URL+"/api/me/outputs/laptop/"+operation, outputAccessRevision(t, sibling))
		if code != 404 || strings.Contains(raw, "accessRevision") {
			t.Fatalf("foreign output: status=%d", code)
		}
	}
	assertAccessRevisionFeed(t, srv.URL, sibling, 200)
	assertAccessRevisionFeed(t, srv.URL, foreign, 200)
}

func TestOutputAccessRevisionOmittedHeaderRetainsLegacyCurrentRecordMutation(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "legacy-output")
	opened := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	code, first, _ := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/rotate")
	if code != 200 {
		t.Fatalf("legacy rotate: status=%d", code)
	}
	code, second, _ := mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/rotate")
	if code != 200 || outputAccessRevision(t, first) == outputAccessRevision(t, second) {
		t.Fatalf("legacy repeated rotate: status=%d", code)
	}
	// This compatibility branch intentionally does not provide idempotent replay.
	assertAccessRevisionFeed(t, srv.URL, opened, 404)
	assertAccessRevisionFeed(t, srv.URL, first, 404)
	assertAccessRevisionFeed(t, srv.URL, second, 200)
	code, _, _ = mutateOpenedOutput(t, owner, srv.URL+"/api/me/outputs/phone/revoke")
	if code != 200 {
		t.Fatalf("legacy revoke: status=%d", code)
	}
	assertAccessRevisionFeed(t, srv.URL, second, 404)
}
