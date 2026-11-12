package store_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestCreateNodeRequiresAbsenceAndReturnsCommittedOptions(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{81}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := domain.Node{
		ID: "created", Name: "Original", Host: "endpoint.invalid", Port: 443, Protocol: "vless",
		UUID: "00000000-0000-4000-8000-000000000001", Status: "online", Region: "test",
		CoreID: "metadata-only", CoreVersion: "test", Tags: []string{"fixture"},
		TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls.invalid", ALPN: []string{"http/1.1"}},
		Transport: &domain.TransportOptions{Type: "ws", Path: "/proxy", Host: "cdn.invalid", Headers: map[string]string{"X-Client": "fixture"}},
	}
	created, err := s.CreateNode(input)
	expected := input
	expected.Status = "unregistered"
	if err != nil || !reflect.DeepEqual(created, expected) {
		t.Fatalf("creation did not return the validated committed options: %v", err)
	}
	var saved domain.Node
	if err := s.Get("nodes", input.ID, &saved); err != nil || !reflect.DeepEqual(saved, expected) {
		t.Fatalf("receipt differs from stored node: %v", err)
	}
	if _, err := s.CreateNode(input); !errors.Is(err, store.ErrNodeExists) {
		t.Fatalf("identical replay must conflict: %v", err)
	}
	newer := expected
	newer.Name, newer.Host = "Newer", "edited.invalid"
	if err := s.PutNode(newer); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateNode(input); !errors.Is(err, store.ErrNodeExists) {
		t.Fatalf("retry after edit must conflict: %v", err)
	}
	if err := s.Get("nodes", input.ID, &saved); err != nil || !reflect.DeepEqual(saved, newer) {
		t.Fatalf("retry overwrote later edit: %v", err)
	}
}

func TestCreateNodeCompetingStoreHandlesHaveExactlyOneWinner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{82}, 32)
	first, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	start := make(chan struct{})
	type result struct {
		node domain.Node
		err  error
	}
	results := make(chan result, 8)
	for i := 0; i < 8; i++ {
		s := []*store.Store{first, second}[i%2]
		input := domain.Node{ID: "contended", Name: fmt.Sprintf("Writer %d", i), Host: "endpoint.invalid", Port: 1080 + i, Protocol: "socks"}
		go func(s *store.Store, input domain.Node) {
			<-start
			node, err := s.CreateNode(input)
			results <- result{node, err}
		}(s, input)
	}
	close(start)
	wins, conflicts := 0, 0
	var winner domain.Node
	for i := 0; i < 8; i++ {
		result := <-results
		switch {
		case result.err == nil:
			wins++
			winner = result.node
		case errors.Is(result.err, store.ErrNodeExists):
			conflicts++
		default:
			t.Fatalf("unexpected writer result: %v", result.err)
		}
	}
	if wins != 1 || conflicts != 7 {
		t.Fatalf("got %d winners and %d conflicts", wins, conflicts)
	}
	for _, s := range []*store.Store{first, second} {
		var saved domain.Node
		if err := s.Get("nodes", winner.ID, &saved); err != nil || !reflect.DeepEqual(saved, winner) {
			t.Fatalf("losing creation replaced winner: %v", err)
		}
	}
}

func TestCreateNodeValidationAndLegacyUpsertRemainIntact(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{83}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	valid := domain.Node{ID: "legacy", Name: "Original", Host: "endpoint.invalid", Port: 1080, Protocol: "socks"}
	for _, mutate := range []func(*domain.Node){
		func(n *domain.Node) { n.ID = "bad/id" },
		func(n *domain.Node) { n.Name = " " },
		func(n *domain.Node) { n.Port = 65536 },
		func(n *domain.Node) { n.Host = "https://endpoint.invalid" },
		func(n *domain.Node) { n.Protocol = "synthetic-sensitive-value" },
		func(n *domain.Node) { n.Password = "synthetic-sensitive-value" },
		func(n *domain.Node) { n.Transport = &domain.TransportOptions{Type: "ws"} },
	} {
		input := valid
		mutate(&input)
		if _, err := s.CreateNode(input); !errors.Is(err, store.ErrInvalidNodeInput) {
			t.Fatalf("invalid creation was not classified: %v", err)
		}
		if err := s.PutNode(input); err == nil {
			t.Fatal("legacy validation was bypassed")
		}
	}
	if state, err := s.State(); err != nil || len(state.Nodes) != 0 {
		t.Fatalf("invalid input persisted nodes: %v", err)
	}
	for _, name := range []string{"Original", "Updated"} {
		valid.Name, valid.Status = name, "online"
		if err := s.PutNode(valid); err != nil {
			t.Fatal(err)
		}
		var saved domain.Node
		if err := s.Get("nodes", valid.ID, &saved); err != nil || saved.Name != name || saved.Status != "unregistered" {
			t.Fatalf("legacy upsert changed: %v", err)
		}
	}
}

func TestCreateNodePreservesUsagePolicyAndServerInventory(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{84}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// A different kind with the same ID must not block a connection record.
	if err := s.PutUser(domain.User{ID: "shared-id", Name: "User", Enabled: true, QuotaBytes: 100}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordUsage("shared-id", "observed", 35); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"hosts", "core-instances", "managed-endpoints", "server-deployments"} {
		if err := s.Put(kind, "existing", map[string]string{"id": "existing", "name": "Preserve this fixture"}); err != nil {
			t.Fatal(err)
		}
	}
	kinds := []string{"hosts", "core-instances", "managed-endpoints", "server-deployments", "users", "routes", "revisions", "ledger", "usage", "services", "entitlements", "accounts", "invites", "sessions", "principals", "api-credentials"}
	before := map[string][]json.RawMessage{}
	for _, kind := range kinds {
		rows, err := s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		before[kind] = rows
	}
	now := time.Now().UTC()
	policyBefore, err := s.EffectivePolicy("shared-id", now)
	if err != nil {
		t.Fatal(err)
	}
	input := domain.Node{ID: "shared-id", Name: "Connection", Host: "endpoint.invalid", Port: 1080, Protocol: "socks", CoreID: "metadata-only"}
	if _, err := s.CreateNode(input); err != nil {
		t.Fatal(err)
	}
	input.Name = "Replacement"
	if _, err := s.CreateNode(input); !errors.Is(err, store.ErrNodeExists) {
		t.Fatalf("duplicate creation did not conflict: %v", err)
	}
	for _, kind := range kinds {
		after, err := s.List(kind)
		if err != nil || !reflect.DeepEqual(after, before[kind]) {
			t.Fatalf("node creation changed unrelated %s records: %v", kind, err)
		}
	}
	policyAfter, err := s.EffectivePolicy("shared-id", now)
	if err != nil || !reflect.DeepEqual(policyAfter, policyBefore) {
		t.Fatalf("node creation changed effective policy: %v", err)
	}
}

func TestCreateNodeConnectionSecretsRemainEncryptedAfterReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{85}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := domain.Node{ID: "encrypted", Name: "Encrypted", Host: "endpoint.invalid", Port: 1080, Protocol: "socks", Username: "synthetic-user-only", Password: "synthetic-password-never-external"}
	created, err := s.CreateNode(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal"} {
		data, err := os.ReadFile(path + suffix)
		if suffix != "" && errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(input.Username)) || bytes.Contains(data, []byte(input.Password)) {
			t.Fatal("connection authentication stored as plaintext")
		}
	}
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var saved domain.Node
	if err := reopened.Get("nodes", input.ID, &saved); err != nil || !reflect.DeepEqual(saved, created) {
		t.Fatalf("encrypted record did not survive reopen: %v", err)
	}
}
