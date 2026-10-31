package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// Explicit guarded fixture update. Tests for stale/missing headers call raw HTTP
// instead; this helper does not change req or silently repair failed mutations.
func putAdminRecord(t *testing.T, client *http.Client, url, revision string, value any) (int, map[string]any, string) {
	t.Helper()
	raw, _ := json.Marshal(value)
	request, _ := http.NewRequest("PUT", url, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", revision)
	response, e := client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	out := map[string]any{}
	_ = json.Unmarshal(body, &out)
	return response.StatusCode, out, string(body)
}
func (f fleetFixture) saveDeployment(t *testing.T, value any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(value)
	var identity struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &identity)
	url := f.srv.URL + "/api/server-deployments/" + identity.ID
	code, current, body := req(t, operatorClient(), "GET", url, "", nil)
	if code == 404 {
		return f.post(t, "server-deployments", value, 200)
	}
	if code != 200 {
		t.Fatalf("read deployment baseline %d %s", code, body)
	}
	code, out, body := putAdminRecord(t, operatorClient(), url, current["revisionToken"].(string), value)
	if code != 200 {
		t.Fatalf("guarded deployment update %d %s", code, body)
	}
	return out
}
