package httpapi_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func nodeCreationRequest(t *testing.T, base string, input any, conditions ...string) *http.Request {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequest(http.MethodPost, base+"/api/nodes", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	for _, condition := range conditions {
		r.Header.Add("If-None-Match", condition)
	}
	return r
}

func sendNodeCreation(t *testing.T, client *http.Client, request *http.Request) (int, map[string]any, string) {
	t.Helper()
	response, err := client.Do(request)
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
		t.Fatal("node creation response was not a JSON object")
	}
	return response.StatusCode, value, string(body)
}

func TestNodeCreationInvalidHeadersNeverDowngradeToUpsert(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	original := domain.Node{ID: "existing", Name: "Original", Host: "endpoint.invalid", Port: 1080, Protocol: "socks", Status: "unregistered"}
	if err := s.PutNode(original); err != nil {
		t.Fatal(err)
	}
	for _, conditions := range [][]string{
		{""}, {" \t "}, {"not-a-precondition"}, {`"*"`}, {`W/"version"`}, {"*, *"}, {"*", "*"}, {"*", ""}, {"", "*"},
	} {
		for _, id := range []string{"existing", "absent"} {
			input := original
			input.ID, input.Name = id, "Replacement"
			code, rejected, raw := sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input, conditions...))
			if code != http.StatusBadRequest || rejected["code"] != "NODE_CREATION_PRECONDITION_INVALID" {
				t.Fatalf("invalid header %q was not rejected: %d %s", conditions, code, raw)
			}
		}
	}
	var saved domain.Node
	if err := s.Get("nodes", original.ID, &saved); err != nil || !reflect.DeepEqual(saved, original) {
		t.Fatalf("invalid precondition changed the existing node: %v", err)
	}
	if err := s.Get("nodes", "absent", &saved); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("invalid precondition inserted a node: %v", err)
	}
}

func TestNodeGuardedCreationReceiptReplayAndLaterEdit(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	kinds := []string{"hosts", "core-instances", "managed-endpoints", "server-deployments", "users", "routes", "revisions", "accounts", "invites", "sessions", "principals", "api-credentials"}
	before := map[string][]json.RawMessage{}
	for _, kind := range kinds {
		rows, err := s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		before[kind] = rows
	}
	input := domain.Node{
		ID: "guarded", Name: "Original", Host: "endpoint.invalid", Port: 443, Protocol: "vless", Status: "online",
		UUID: "00000000-0000-4000-8000-000000000001", Region: "test", Tags: []string{"fixture"},
		CoreID: "metadata-only", CoreVersion: "test",
		TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls.invalid", ALPN: []string{"http/1.1"}},
		Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy", Host: "cdn.invalid", Headers: map[string]string{"X-Client": "fixture"}},
	}
	code, _, raw := sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input, " \t*\t "))
	var receipt domain.Node
	if err := json.Unmarshal([]byte(raw), &receipt); err != nil || code != http.StatusOK {
		t.Fatalf("guarded create: %d %v", code, err)
	}
	expected := input
	expected.Status = "unregistered"
	var saved domain.Node
	if err := s.Get("nodes", input.ID, &saved); err != nil || !reflect.DeepEqual(receipt, expected) || !reflect.DeepEqual(saved, receipt) {
		t.Fatalf("receipt does not match persisted options: %v", err)
	}
	code, rejected, _ := sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input, "*"))
	if code != http.StatusPreconditionFailed || rejected["code"] != "NODE_CREATION_CONFLICT" {
		t.Fatalf("identical replay must conflict: %d", code)
	}
	newer := expected
	newer.Name, newer.Host = "Newer", "edited.invalid"
	if code, _, _ := req(t, admin, http.MethodPut, srv.URL+"/api/nodes/"+input.ID, "", newer); code != http.StatusOK {
		t.Fatalf("legacy edit: %d", code)
	}
	code, rejected, _ = sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input, "*"))
	if code != http.StatusPreconditionFailed || rejected["code"] != "NODE_CREATION_CONFLICT" {
		t.Fatalf("retry after edit must conflict: %d", code)
	}
	if err := s.Get("nodes", input.ID, &saved); err != nil || !reflect.DeepEqual(saved, newer) {
		t.Fatalf("guarded retry replaced a newer node: %v", err)
	}
	for _, kind := range kinds {
		after, err := s.List(kind)
		if err != nil || !reflect.DeepEqual(after, before[kind]) {
			t.Fatalf("HTTP creation changed unrelated %s records: %v", kind, err)
		}
	}
}

func TestNodeCreationValidationCodesAndLegacyWrites(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	valid := domain.Node{ID: "legacy", Name: "Created", Host: "endpoint.invalid", Port: 1080, Protocol: "socks"}
	for _, mutate := range []func(*domain.Node){
		func(n *domain.Node) { n.ID = "bad/id" },
		func(n *domain.Node) { n.Name = " " },
		func(n *domain.Node) { n.Port = 0 },
		func(n *domain.Node) { n.Host = "https://invalid.invalid" },
		func(n *domain.Node) { n.Protocol = "synthetic-sensitive-value" },
		func(n *domain.Node) { n.Password = "synthetic-sensitive-value" },
		func(n *domain.Node) { n.TLS = &domain.TLSOptions{Enabled: true} },
	} {
		input := valid
		mutate(&input)
		code, body, raw := sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input, "*"))
		if code != http.StatusBadRequest || body["code"] != "NODE_CREATION_INVALID" || strings.Contains(raw, "synthetic-sensitive-value") {
			t.Fatalf("guarded validation must be explicit and redact input: %d", code)
		}
		code, body, _ = sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, input))
		if code != http.StatusBadRequest || body["code"] != nil {
			t.Fatalf("legacy POST validation changed: %d", code)
		}
		if input.ID == valid.ID {
			if code, _, _ := req(t, admin, http.MethodPut, srv.URL+"/api/nodes/"+input.ID, "", input); code != http.StatusBadRequest {
				t.Fatalf("legacy PUT validation changed: %d", code)
			}
		}
	}
	if state, err := s.State(); err != nil || len(state.Nodes) != 0 {
		t.Fatalf("invalid requests persisted nodes: %v", err)
	}
	for _, name := range []string{"Created", "Updated by POST"} {
		valid.Name = name
		code, body, _ := sendNodeCreation(t, admin, nodeCreationRequest(t, srv.URL, valid))
		if code != http.StatusOK || body["name"] != name || body["status"] != "unregistered" {
			t.Fatalf("legacy POST upsert changed: %d", code)
		}
	}
	// PUT still creates an absent ID and ignores create-only semantics.
	valid.ID, valid.Name = "put-created", "Created by PUT"
	request := nodeCreationRequest(t, srv.URL, valid, "*")
	request.Method = http.MethodPut
	request.URL.Path = "/api/nodes/" + valid.ID
	if code, _, _ := sendNodeCreation(t, admin, request); code != http.StatusOK {
		t.Fatalf("PUT no longer creates: %d", code)
	}
	valid.Name = "Updated by PUT"
	request = nodeCreationRequest(t, srv.URL, valid, "*")
	request.Method = http.MethodPut
	request.URL.Path = "/api/nodes/" + valid.ID
	if code, body, _ := sendNodeCreation(t, admin, request); code != http.StatusOK || body["name"] != valid.Name {
		t.Fatalf("PUT must remain unconditional: %d", code)
	}
	if code, _, _ := req(t, admin, http.MethodPut, srv.URL+"/api/nodes/different", "", valid); code != http.StatusBadRequest {
		t.Fatalf("PUT ID mismatch accepted: %d", code)
	}
}

func TestNodeGuardedCreationStorageFailureIsNotValidation(t *testing.T) {
	s, srv := makeServer(t)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	input := domain.Node{ID: "unavailable", Name: "Unavailable", Host: "endpoint.invalid", Port: 1080, Protocol: "socks"}
	code, body, _ := sendNodeCreation(t, operatorClient(), nodeCreationRequest(t, srv.URL, input, "*"))
	if code != http.StatusInternalServerError || body["code"] != nil {
		t.Fatalf("storage failure mislabeled as safe rejection: %d", code)
	}
}

func TestNodeGuardedCreationKeepsAuthenticationAdminAndMutationGuards(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "node-create-authority")
	input := domain.Node{ID: "protected", Name: "Protected", Host: "endpoint.invalid", Port: 1080, Protocol: "socks"}
	for _, test := range []struct {
		name   string
		client *http.Client
		csrf   string
		origin string
		status int
	}{
		{"anonymous", http.DefaultClient, "", "", http.StatusUnauthorized},
		{"tenant missing csrf", user.c, "", "", http.StatusForbidden},
		{"tenant with csrf", user.c, user.csrf, "", http.StatusForbidden},
		{"foreign origin", operatorClient(), "", "https://foreign.example", http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := nodeCreationRequest(t, srv.URL, input, "*")
			request.Header.Set("X-CSRF-Token", test.csrf)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if code, _, raw := sendNodeCreation(t, test.client, request); code != test.status {
				t.Fatalf("guarded create authority: %d %s", code, raw)
			}
		})
	}
	var saved domain.Node
	if err := s.Get("nodes", input.ID, &saved); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unauthorized request created node: %v", err)
	}
}
