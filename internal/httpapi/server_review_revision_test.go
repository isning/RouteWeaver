package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The caller supplies the exact revision it opened. This helper never reloads
// or repairs a rejected review on the caller's behalf.
func validateOpenedServer(t *testing.T, client *http.Client, url, revision string) (int, map[string]any, string) {
	t.Helper()
	r, _ := http.NewRequest("POST", url+"/validate", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	if revision != "" {
		r.Header.Set("If-Match", revision)
	}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	out := map[string]any{}
	_ = json.Unmarshal(body, &out)
	return response.StatusCode, out, string(body)
}

func openServerDraft(t *testing.T, client *http.Client, url string) map[string]any {
	t.Helper()
	code, opened, raw := req(t, client, "GET", url, "", nil)
	if code != 200 || opened["revisionToken"] == "" || opened["revisionToken"] == nil {
		t.Fatalf("open server draft: %d %s", code, raw)
	}
	return opened
}

func requireServerValidation(t *testing.T, client *http.Client, url, openedRevision string) map[string]any {
	t.Helper()
	code, checked, raw := validateOpenedServer(t, client, url, openedRevision)
	if code != 200 {
		t.Fatalf("validate opened draft: %d %s", code, raw)
	}
	return checked
}

func TestServerValidationRequiresDisplayedDraftRevision(t *testing.T) {
	f := newFleetFixture(t)
	admin := operatorClient()
	url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
	code, opened, raw := req(t, admin, "GET", url+"/reveal", "", nil)
	if code != 200 {
		t.Fatal(code, raw)
	}
	oldRevision := opened["revisionToken"].(string)
	// A second editor changes forwarding after the first operator opened it.
	programs := opened["ir"].(map[string]any)["programs"].([]any)
	programs[0].(map[string]any)["defaultAction"] = map[string]any{"kind": "reject"}
	delete(opened, "revisionToken")
	code, saved, raw := putAdminRecord(t, admin, url, oldRevision, opened)
	if code != 200 {
		t.Fatal(code, raw)
	}
	for _, revision := range []string{"", oldRevision} {
		code, response, raw := validateOpenedServer(t, admin, url, revision)
		if code != 409 || response["code"] != "SERVER_DRAFT_CHANGED" || response["fingerprint"] != nil {
			t.Errorf("unreviewed draft received usable validation: %d %s", code, raw)
		}
		if strings.Contains(raw, "fixture-password") || strings.Contains(raw, "fixture-user") {
			t.Fatal("review conflict exposed credentials")
		}
	}
	code, response, raw := validateOpenedServer(t, admin, url, saved["revisionToken"].(string))
	if code != 200 || response["valid"] != true || response["fingerprint"] == nil {
		t.Fatalf("explicitly reopened draft cannot be checked: %d %s", code, raw)
	}
	if strings.Contains(raw, "fixture-password") || strings.Contains(raw, "fixture-user") {
		t.Fatal("review exposed credentials")
	}
	checkedFingerprint := response["fingerprint"]
	// A later save still invalidates the checked fingerprint at publish time.
	programs[0].(map[string]any)["defaultAction"] = map[string]any{"kind": "direct"}
	code, latest, raw := putAdminRecord(t, admin, url, saved["revisionToken"].(string), opened)
	if code != 200 {
		t.Fatal(code, raw)
	}
	code, rejected, raw := req(t, admin, "POST", url+"/publish", "", map[string]any{"operationId": "publish-stale", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checkedFingerprint})
	if code != 200 || rejected["status"] != "definitively-rejected" || rejected["code"] != "SERVER_DRAFT_CHANGED" {
		t.Fatalf("changed-after-check draft was not refused: %d %s", code, raw)
	}
	// Secret-only drift is included even though ordinary views omit the secret.
	programs[0].(map[string]any)["listener"].(map[string]any)["connection"].(map[string]any)["password"] = "new-private-fixture-marker"
	code, _, raw = putAdminRecord(t, admin, url, latest["revisionToken"].(string), opened)
	if code != 200 {
		t.Fatal(code, raw)
	}
	code, rejected, raw = validateOpenedServer(t, admin, url, latest["revisionToken"].(string))
	if code != 409 || rejected["code"] != "SERVER_DRAFT_CHANGED" || rejected["fingerprint"] != nil || strings.Contains(raw, "private-fixture-marker") {
		t.Fatalf("secret-only drift escaped opened-record review: %d %s", code, raw)
	}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, admin, "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 || state["phase"] != "unregistered" {
			t.Fatalf("checking queued an instance: %d %s", code, raw)
		}
	}
}
