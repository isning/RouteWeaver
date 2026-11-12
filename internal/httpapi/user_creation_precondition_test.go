package httpapi_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
)

func userCreationRequest(t *testing.T, base string, input any, conditions ...string) *http.Request {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequest(http.MethodPost, base+"/api/users", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	for _, condition := range conditions {
		r.Header.Add("If-None-Match", condition)
	}
	return r
}

func TestUserCreationInvalidHeadersNeverDowngradeToUpsert(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	original := domain.User{ID: "existing", Name: "Original", Enabled: true, QuotaBytes: 100}
	if err := s.PutUser(original); err != nil {
		t.Fatal(err)
	}
	for _, conditions := range [][]string{
		{""}, {" \t "}, {"not-a-precondition"}, {`"*"`}, {`W/"version"`}, {"*, *"}, {"*", "*"}, {"*", ""}, {"", "*"},
	} {
		for _, id := range []string{"existing", "absent"} {
			input := domain.User{ID: id, Name: "Replacement", Enabled: false, QuotaBytes: 200}
			code, rejected, raw := sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input, conditions...))
			if code != http.StatusBadRequest || rejected["code"] != "USER_CREATION_PRECONDITION_INVALID" {
				t.Fatalf("invalid header %q was not rejected: %d %s", conditions, code, raw)
			}
		}
	}
	var saved domain.User
	if err := s.Get("users", original.ID, &saved); err != nil || saved != original {
		t.Fatalf("invalid precondition changed the existing user: %+v %v", saved, err)
	}
	if err := s.Get("users", "absent", &saved); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("invalid precondition inserted an absent user: %v", err)
	}
}

func TestUserCreationValidationCodesAreExplicitAndLegacyWritesRemainCompatible(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	for _, input := range []domain.User{
		{ID: "bad/id", Name: "Invalid"},
		{ID: "empty-name"},
		{ID: "negative-quota", Name: "Invalid", QuotaBytes: -1},
	} {
		code, body, raw := sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input, "*"))
		if code != http.StatusBadRequest || body["code"] != "USER_CREATION_INVALID" {
			t.Fatalf("guarded validation: %d %s", code, raw)
		}
		code, body, raw = sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input))
		if code != http.StatusBadRequest || body["code"] != nil {
			t.Fatalf("legacy validation response changed: %d %s", code, raw)
		}
	}
	input := domain.User{ID: "legacy", Name: "Created", Enabled: true, QuotaBytes: 100, UsedBytes: 99}
	code, body, raw := sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input))
	if code != http.StatusOK || body["usedBytes"] != float64(0) {
		t.Fatalf("legacy create: %d %s", code, raw)
	}
	if err := s.RecordUsage(input.ID, "observed", 25); err != nil {
		t.Fatal(err)
	}
	input.Name, input.QuotaBytes, input.UsedBytes = "Updated by POST", 200, 0
	code, body, raw = sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input))
	if code != http.StatusOK || body["name"] != input.Name || body["usedBytes"] != float64(25) {
		t.Fatalf("unguarded POST must remain upsert: %d %s", code, raw)
	}
	input.Name = "Updated by PUT"
	if code, body, raw = req(t, admin, http.MethodPut, srv.URL+"/api/users/legacy", "", input); code != http.StatusOK || body["name"] != input.Name || body["usedBytes"] != float64(25) {
		t.Fatalf("PUT compatibility: %d %s", code, raw)
	}
	if code, _, raw = req(t, admin, http.MethodPut, srv.URL+"/api/users/different", "", input); code != http.StatusBadRequest {
		t.Fatalf("PUT ID mismatch accepted: %d %s", code, raw)
	}
}

func TestUserGuardedCreationKeepsAuthenticationAdminAndMutationGuards(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "user-create-authority")
	input := domain.User{ID: "protected", Name: "Protected", Enabled: true}
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
			request := userCreationRequest(t, srv.URL, input, "*")
			request.Header.Set("X-CSRF-Token", test.csrf)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if code, _, raw := sendUserCreation(t, test.client, request); code != test.status {
				t.Fatalf("guarded create authority: %d %s", code, raw)
			}
		})
	}
	var saved domain.User
	if err := s.Get("users", input.ID, &saved); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unauthorized request created user: %v", err)
	}
}

func TestUserGuardedCreationStorageFailureIsNotReportedAsValidation(t *testing.T) {
	s, srv := makeServer(t)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	input := domain.User{ID: "unavailable", Name: "Unavailable", Enabled: true}
	code, body, raw := sendUserCreation(t, operatorClient(), userCreationRequest(t, srv.URL, input, "*"))
	if code != http.StatusInternalServerError || body["code"] != nil {
		t.Fatalf("storage failure mislabeled as a safe rejection: %d %s", code, raw)
	}
}

func sendUserCreation(t *testing.T, client *http.Client, request *http.Request) (int, map[string]any, string) {
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
		t.Fatal("user creation response was not a JSON object")
	}
	return response.StatusCode, value, string(body)
}

func TestUserGuardedCreationRetryDoesNotReplaceNewerUser(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	input := domain.User{ID: "guarded", Name: "Original", Enabled: true, QuotaBytes: 100, UsedBytes: 99}
	code, created, raw := sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input, " \t*\t "))
	if code != http.StatusOK || created["id"] != "guarded" || created["usedBytes"] != float64(0) {
		t.Fatalf("guarded create: %d %s", code, raw)
	}
	if err := s.RecordUsage(input.ID, "observed", 35); err != nil {
		t.Fatal(err)
	}
	newer := domain.User{ID: input.ID, Name: "Newer", Enabled: false, QuotaBytes: 200}
	if code, _, raw := req(t, admin, http.MethodPut, srv.URL+"/api/users/"+input.ID, "", newer); code != http.StatusOK {
		t.Fatalf("legacy edit: %d %s", code, raw)
	}
	code, rejected, raw := sendUserCreation(t, admin, userCreationRequest(t, srv.URL, input, "*"))
	if code != http.StatusPreconditionFailed || rejected["code"] != "USER_CREATION_CONFLICT" {
		t.Fatalf("guarded retry must fail the absence precondition: %d %s", code, raw)
	}
	var saved domain.User
	if err := s.Get("users", input.ID, &saved); err != nil || saved.Name != "Newer" || saved.Enabled || saved.QuotaBytes != 200 || saved.UsedBytes != 35 {
		t.Fatalf("guarded retry changed a newer user: %+v %v", saved, err)
	}
}
