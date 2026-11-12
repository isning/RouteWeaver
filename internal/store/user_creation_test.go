package store_test

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestCreateUserRequiresAbsenceAndPreservesUsageAndPolicy(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := domain.User{ID: "created", Name: "Original", Enabled: true, QuotaBytes: 100, UsedBytes: 99}
	created, err := s.CreateUser(input)
	if err != nil || created.ID != input.ID || created.Name != "Original" || created.UsedBytes != 0 {
		t.Fatalf("create must return committed user with server-owned usage: %+v %v", created, err)
	}
	if err := s.RecordUsage(input.ID, "observed", 35); err != nil {
		t.Fatal(err)
	}
	var before domain.User
	if err := s.Get("users", input.ID, &before); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	policyBefore, err := s.EffectivePolicy(input.ID, now)
	if err != nil || policyBefore.UserID != "created" || policyBefore.Status != "active" || policyBefore.QuotaBytes != 100 || policyBefore.Entitlement.Cycle.Mode != "none" {
		t.Fatalf("new user did not initialize its default policy: %+v %v", policyBefore, err)
	}
	input.Name, input.Enabled, input.QuotaBytes, input.UsedBytes = "Replacement", false, 200, 0
	if _, err := s.CreateUser(input); !errors.Is(err, store.ErrUserExists) {
		t.Fatalf("duplicate creation must fail: %v", err)
	}
	var after domain.User
	if err := s.Get("users", input.ID, &after); err != nil || after != before || after.UsedBytes != 35 {
		t.Fatalf("conflict changed saved user or usage: %+v %v", after, err)
	}
	policyAfter, err := s.EffectivePolicy(input.ID, now)
	if err != nil || !reflect.DeepEqual(policyAfter, policyBefore) {
		t.Fatalf("conflict changed effective policy: %+v %v", policyAfter, err)
	}
}

func TestCreateUserCompetingStoreHandlesHaveExactlyOneWinner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{73}, 32)
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
	// Separate Store handles have separate in-process locks. The absence fence
	// must survive simultaneous writers to the same SQLite database.
	start := make(chan struct{})
	type result struct {
		user domain.User
		err  error
	}
	results := make(chan result, 8)
	for i := 0; i < 8; i++ {
		s := []*store.Store{first, second}[i%2]
		input := domain.User{ID: "contended", Name: fmt.Sprintf("Writer %d", i), Enabled: true, QuotaBytes: int64(100 + i)}
		go func(s *store.Store, input domain.User) {
			<-start
			user, err := s.CreateUser(input)
			results <- result{user, err}
		}(s, input)
	}
	close(start)
	wins, conflicts := 0, 0
	var winner domain.User
	for i := 0; i < 8; i++ {
		result := <-results
		switch {
		case result.err == nil:
			wins++
			winner = result.user
		case errors.Is(result.err, store.ErrUserExists):
			conflicts++
		default:
			t.Fatalf("unexpected writer result: %v", result.err)
		}
	}
	if wins != 1 || conflicts != 7 {
		t.Fatalf("got %d winners and %d conflicts", wins, conflicts)
	}
	for _, s := range []*store.Store{first, second} {
		var saved domain.User
		if err := s.Get("users", winner.ID, &saved); err != nil || saved != winner {
			t.Fatalf("a losing create replaced the winner: %+v %v", saved, err)
		}
	}
}

func TestCreateUserValidationAndLegacyUpsertRemainIntact(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{74}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, invalid := range []domain.User{
		{ID: "bad/id", Name: "Invalid"},
		{ID: "empty-name"},
		{ID: "negative-quota", Name: "Invalid", QuotaBytes: -1},
	} {
		if _, err := s.CreateUser(invalid); !errors.Is(err, store.ErrInvalidUserInput) {
			t.Fatalf("invalid user was accepted: %+v %v", invalid, err)
		}
		if err := s.PutUser(invalid); !errors.Is(err, store.ErrInvalidUserInput) {
			t.Fatalf("legacy validation changed: %+v %v", invalid, err)
		}
	}
	if state, err := s.State(); err != nil || len(state.Users) != 0 {
		t.Fatalf("invalid input left a user: %+v %v", state, err)
	}
	input := domain.User{ID: "legacy", Name: "Legacy", Enabled: true, QuotaBytes: 100, UsedBytes: 500}
	if err := s.PutUser(input); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordUsage(input.ID, "observed", 20); err != nil {
		t.Fatal(err)
	}
	input.Name, input.QuotaBytes, input.UsedBytes = "Updated", 200, 0
	if err := s.PutUser(input); err != nil {
		t.Fatal(err)
	}
	var saved domain.User
	if err := s.Get("users", input.ID, &saved); err != nil || saved.Name != "Updated" || saved.QuotaBytes != 200 || saved.UsedBytes != 20 {
		t.Fatalf("legacy upsert or usage preservation changed: %+v %v", saved, err)
	}
	for _, kind := range []string{"accounts", "invites", "sessions"} {
		if rows, err := s.List(kind); err != nil || len(rows) != 0 {
			t.Fatalf("user creation unexpectedly changed credentials (%s): %v", kind, err)
		}
	}
}

func TestUserCreationKeepsIssuedBudgetPolicyGuard(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	// Use the legacy direct-route policy so the user's own quota is effective,
	// rather than the fixture service's unlimited quota overriding it.
	if err := s.Remove("entitlements", "account"); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("routes", "route", domain.Route{ID: "route", Name: "Direct route", UserIDs: []string{"account"}}); err != nil {
		t.Fatal(err)
	}
	lease, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "user-create-guard"), now)
	if err != nil || !lease.Allowed || lease.ByteBudget == nil {
		t.Fatalf("initial budget: %+v %v", lease, err)
	}
	if _, err := s.CreateUser(domain.User{ID: "new-user", Name: "New", Enabled: true, QuotaBytes: 100}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(domain.User{ID: "account", Name: "Replacement", Enabled: true, QuotaBytes: 1}); !errors.Is(err, store.ErrUserExists) {
		t.Fatalf("guarded create changed an existing budget owner: %v", err)
	}
	if err := s.PutUser(domain.User{ID: "account", Name: "Lowered", Enabled: true, QuotaBytes: 1}); err == nil {
		t.Fatal("legacy upsert bypassed the issued byte budget guard")
	}
	var saved domain.User
	if err := s.Get("users", "account", &saved); err != nil || saved.Name != "Fixture" || saved.QuotaBytes != 1000 {
		t.Fatalf("rejected policy mutation was not rolled back: %+v %v", saved, err)
	}
}
