package httpapi_test

import (
	"bytes"
	"database/sql"
	"io"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestSecretRevealRequiresDurableAudit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, err := store.Open(path, bytes.Repeat([]byte{11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	srv := httptest.NewServer(httpapi.New(s, render.Default(), "012345678901234567890123456789012345", ""))
	defer srv.Close()
	owner := inviteClient(t, s, srv, "audit-owner")
	secret := "synthetic-required-audit-secret"
	endpoint := domain.ClientEndpoint{ID: "node", Name: "Node", Connection: domain.Connection{Host: "example.com", Port: 443, Protocol: "trojan", Password: secret}}
	source := httpapi.Source{ID: "source", Name: "Source", Content: secret, Candidate: &httpapi.SourceCandidate{ID: "candidate", Snapshot: &domain.SourceSnapshot{Endpoints: []domain.ClientEndpoint{endpoint}}}}
	if err = s.TenantPut(owner.id, "sources", source.ID, source); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("managed-endpoints", "endpoint", domain.ManagedEndpoint{ID: "endpoint", Connection: endpoint.Connection}); err != nil {
		t.Fatal(err)
	}
	if err = s.TenantPut(owner.id, "platform-entries", "entry", httpapi.PublicEntryGrant{ID: "entry", UserID: owner.id, Connection: endpoint.Connection}); err != nil {
		t.Fatal(err)
	}
	fault, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`CREATE TRIGGER reject_required_audit BEFORE INSERT ON records WHEN NEW.kind='audit' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path  string
		admin bool
	}{{"/api/managed-endpoints/endpoint/reveal", true}, {"/api/users/" + owner.id + "/entries/entry/reveal", true}, {"/api/me/sources/source/reveal", false}, {"/api/me/sources/source/candidate/reveal", false}} {
		client := owner.c
		if tc.admin {
			client = operatorClient()
		}
		response, e := client.Get(srv.URL + tc.path)
		if e != nil {
			t.Fatal(e)
		}
		payload, e := io.ReadAll(response.Body)
		response.Body.Close()
		if e != nil {
			t.Fatal(e)
		}
		code, body := response.StatusCode, string(payload)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("reveal failure lacks no-store: %s", tc.path)
		}
		if code != 503 || strings.Contains(body, secret) || strings.Contains(body, "synthetic audit failure") {
			t.Errorf("audit failure must withhold secret (%s): %d %s", tc.path, code, body)
		}
	}
	if _, err = fault.Exec(`DROP TRIGGER reject_required_audit`); err != nil {
		t.Fatal(err)
	}
	code, _, body := req(t, operatorClient(), "GET", srv.URL+"/api/managed-endpoints/endpoint/reveal", "", nil)
	if code != 200 || !strings.Contains(body, secret) {
		t.Fatalf("audit recovery must allow reveal: %d %s", code, body)
	}
	events, err := s.List("audit")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if bytes.Contains(event, []byte("inventory.secret-revealed")) {
			found = true
		}
		if bytes.Contains(event, []byte(secret)) {
			t.Fatal("audit contains secret")
		}
	}
	if !found {
		t.Fatal("successful reveal lacks audit event")
	}
}
