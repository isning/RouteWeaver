package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"strings"
	"testing"
)

func TestEndpointImpactReviewBindsDraftAndDependencies(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	tenant := inviteClient(t, s, srv, "endpoint-impact-reader")
	instance := domain.CoreInstance{ID: "impact-core", HostID: "impact-host", AdapterID: "routeweaver/xray", Version: "26.3.27"}
	endpoint := domain.ManagedEndpoint{ID: "impact-listener", InstanceID: instance.ID, Name: "Shared entry", Connection: domain.Connection{Host: "127.0.0.1", Port: 1080, Protocol: "socks", Username: "fixture-user", Password: "private-impact-fixture"}}
	deployment := httpapi.ServerDeployment{ID: "impact-draft", Name: "Dependent deployment", IR: domain.ServerDeploymentIR{ID: "impact-draft", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint}}}}
	for _, row := range []struct {
		kind, id string
		value    any
	}{{"core-instances", instance.ID, instance}, {"managed-endpoints", endpoint.ID, endpoint}, {"server-deployments", deployment.ID, deployment}, {"links", "impact-link", domain.Link{ID: "impact-link", From: endpoint.ID, To: "other"}}, {"published-routes", "impact-route", domain.PublishedRoute{ID: "impact-route", Name: "Dependent route", DeploymentID: deployment.ID, EndpointIDs: []string{endpoint.ID}}}} {
		if err := s.Put(row.kind, row.id, row.value); err != nil {
			t.Fatal(err)
		}
	}
	url := srv.URL + "/api/managed-endpoints/" + endpoint.ID
	call := func(method, path, revision, impact string, body any) (int, map[string]any, string) {
		var reader io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		request, _ := http.NewRequest(method, path, reader)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("If-Match", revision)
		request.Header.Set("X-Endpoint-Impact", impact)
		response, err := admin.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		result := map[string]any{}
		_ = json.Unmarshal(raw, &result)
		return response.StatusCode, result, string(raw)
	}
	code, opened, raw := call("GET", url+"/reveal", "", "", nil)
	if code != 200 {
		t.Fatal(code, raw)
	}
	revision, _ := opened["revisionToken"].(string)
	endpoint.Connection.Port = 2080
	code, preview, raw := call("POST", url+"/impact", revision, "", endpoint)
	if code != 200 {
		t.Fatalf("impact preview: %d %s", code, raw)
	}
	if !strings.Contains(raw, "Dependent deployment") || !strings.Contains(raw, "Dependent route") || !strings.Contains(raw, "impact-link") || strings.Contains(raw, "private-impact-fixture") {
		t.Fatal("missing or unsafe impact", raw)
	}
	token, _ := preview["reviewToken"].(string)
	if revision == "" || token == "" {
		t.Fatal("missing opened/draft review fences")
	}
	code, _, raw = call("PUT", url, revision, "", endpoint)
	if code != 409 {
		t.Fatal("unreviewed update accepted", code, raw)
	}
	changed := endpoint
	changed.Connection.Port = 3080
	code, _, raw = call("PUT", url, revision, token, changed)
	if code != 409 {
		t.Fatal("changed reviewed draft accepted", code, raw)
	}
	secretChanged := endpoint
	secretChanged.Connection.Password = "different-private-fixture"
	code, _, raw = call("PUT", url, revision, token, secretChanged)
	if code != 409 {
		t.Fatal("secret-only draft change reused impact token", code, raw)
	}
	if err := s.Put("published-routes", "later-route", domain.PublishedRoute{ID: "later-route", Name: "New dependent", DeploymentID: deployment.ID}); err != nil {
		t.Fatal(err)
	}
	code, _, raw = call("PUT", url, revision, token, endpoint)
	if code != 409 {
		t.Fatal("new dependent did not invalidate impact", code, raw)
	}
	code, preview, raw = call("POST", url+"/impact", revision, "", endpoint)
	if code != 200 || !strings.Contains(raw, "New dependent") {
		t.Fatal(code, raw)
	}
	token = preview["reviewToken"].(string)
	deployment.Name = "Changed dependent name"
	if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
		t.Fatal(err)
	}
	code, _, raw = call("PUT", url, revision, token, endpoint)
	if code != 409 {
		t.Fatal("changed existing dependent did not invalidate impact", code, raw)
	}
	code, preview, raw = call("POST", url+"/impact", revision, "", endpoint)
	if code != 200 || !strings.Contains(raw, "Changed dependent name") {
		t.Fatal(code, raw)
	}
	token = preview["reviewToken"].(string)
	code, _, raw = call("PUT", url, revision, token, endpoint)
	if code != 200 {
		t.Fatal("reviewed save", code, raw)
	}
	code, _, raw = call("PUT", url, revision, token, endpoint)
	if code != 409 {
		t.Fatal("stale opened revision accepted", code, raw)
	}
	code, _, raw = call("POST", srv.URL+"/api/managed-endpoints", "", "", endpoint)
	if code != 409 {
		t.Fatal("POST bypass replaced existing endpoint", code, raw)
	}
	code, _, raw = req(t, tenant.c, "POST", url+"/impact", tenant.csrf, endpoint)
	if code != 403 || strings.Contains(raw, "Dependent route") {
		t.Fatal("tenant impact disclosure", code, raw)
	}
	code, _, raw = req(t, http.DefaultClient, "POST", url+"/impact", "", endpoint)
	if code != 401 {
		t.Fatal("unauthenticated impact", code, raw)
	}
	code, _, raw = call("GET", srv.URL+"/api/server-deployments/"+deployment.ID, "", "", nil)
	if code != 200 || !strings.Contains(raw, `"port":1080`) {
		t.Fatal("inventory edit changed deployment", code, raw)
	}
	code, opened, raw = call("GET", url+"/reveal", "", "", nil)
	if code != 200 {
		t.Fatal(code, raw)
	}
	revision = opened["revisionToken"].(string)
	if err := s.Put("server-deployments", "unknown-shape", map[string]any{"id": "unknown-shape", "futureEndpointRef": "private-unknown-reference"}); err != nil {
		t.Fatal(err)
	}
	code, _, raw = call("POST", url+"/impact", revision, "", endpoint)
	if code != 400 || strings.Contains(raw, "private-unknown-reference") {
		t.Fatal("unknown dependency shape not refused safely", code, raw)
	}
}

// Explicit fixture edit through the same opened-revision and impact review flow
// as an administrator. Never retries or repairs rejected mutations.
func (f fleetFixture) updateEndpoint(t *testing.T, endpoint domain.ManagedEndpoint) {
	t.Helper()
	client := operatorClient()
	url := f.srv.URL + "/api/managed-endpoints/" + endpoint.ID
	code, opened, raw := req(t, client, "GET", url, "", nil)
	if code != 200 {
		t.Fatalf("open endpoint: %d %s", code, raw)
	}
	revision, ok := opened["revisionToken"].(string)
	if !ok || revision == "" {
		t.Fatal("missing endpoint revision")
	}
	call := func(method, path, token string) map[string]any {
		t.Helper()
		body, err := json.Marshal(endpoint)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequest(method, path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("If-Match", revision)
		request.Header.Set("X-Endpoint-Impact", token)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err = io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			t.Fatalf("%s endpoint: %d %s", method, response.StatusCode, body)
		}
		var out map[string]any
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	review := call("POST", url+"/impact", "")
	token, ok := review["reviewToken"].(string)
	if !ok || token == "" {
		t.Fatal("missing endpoint impact review token")
	}
	call("PUT", url, token)
}
