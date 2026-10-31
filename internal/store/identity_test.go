package store_test

import (
	"bytes"
	"github.com/pquerna/otp/totp"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestInviteIsSingleUseAndUsernameUnique(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{3}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	_, token, _ := s.CreateInvite("User", "user", time.Now().Add(time.Hour))
	a, e := s.AcceptInvite(token, "alice", "synthetic-test-password")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.AcceptInvite(token, "another", "synthetic-test-password"); e == nil {
		t.Fatal("invite reused")
	}
	_, second, _ := s.CreateInvite("Other", "user", time.Now().Add(time.Hour))
	if _, e = s.AcceptInvite(second, "ALICE", "synthetic-test-password"); e == nil {
		t.Fatal("case-insensitive username collision")
	}
	if _, e = s.AcceptInvite(second, "bob", "synthetic-test-password"); e != nil {
		t.Fatalf("failed username did not preserve invite: %v", e)
	}
	if _, e = s.Authenticate(a.Username, "wrong-password", "", time.Now()); e == nil {
		t.Fatal("wrong password accepted")
	}
}
func TestTOTPActualStepReplayRejected(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{5}, 32))
	defer s.Close()
	if e := s.EnsureAdmin("admin", "synthetic-admin-password"); e != nil {
		t.Fatal(e)
	}
	var a store.Account
	s.Get("accounts", "admin", &a)
	a.TOTPSecret = "JBSWY3DPEHPK3PXP"
	s.Put("accounts", a.ID, a)
	now := time.Unix(1800000000, 0)
	code, _ := totp.GenerateCode(a.TOTPSecret, now.Add(30*time.Second))
	if _, e := s.Authenticate("admin", "synthetic-admin-password", code, now); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Authenticate("admin", "synthetic-admin-password", code, now.Add(30*time.Second)); e == nil {
		t.Fatal("future-skew code replayed in its own step")
	}
}
func TestEncryptedStateAndSessionSurviveReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{6}, 32)
	s, _ := store.Open(path, key)
	s.EnsureAdmin("admin", "synthetic-admin-password")
	a, e := s.Authenticate("admin", "synthetic-admin-password", "", time.Now())
	if e != nil {
		t.Fatal(e)
	}
	_, token, e := s.NewSession(a, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	s.TenantPut(a.ID, "sources", "private", map[string]string{"secret": "synthetic-private-source"})
	s.Close()
	s, e = store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(token, time.Now()); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(token, time.Now().Add(13*time.Hour)); e == nil {
		t.Fatal("expired session accepted")
	}
	s.Close()
	if wrong, e := store.Open(path, bytes.Repeat([]byte{9}, 32)); e == nil {
		wrong.Close()
		t.Fatal("wrong encryption key accepted")
	}
}

func TestMFAEnableRevokesSessionsAndCannotRepeat(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{4}, 32))
	defer s.Close()
	s.EnsureAdmin("admin", "synthetic-admin-password")
	a, _, oldToken, e := s.Login("admin", "synthetic-admin-password", "", time.Now())
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	secret, _, e := s.BeginMFA(a.ID, "synthetic-admin-password", now)
	if e != nil {
		t.Fatal(e)
	}
	code, _ := totp.GenerateCode(secret, now)
	_, _, newToken, e := s.EnableMFA(a.ID, code, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(oldToken, now); e == nil {
		t.Fatal("pre-MFA session still valid")
	}
	if _, _, e = s.ResolveSession(newToken, now); e != nil {
		t.Fatal(e)
	}
	if _, _, _, e = s.EnableMFA(a.ID, code, now); e == nil {
		t.Fatal("MFA enabled twice")
	}
	if _, e = s.Authenticate("admin", "synthetic-admin-password", "", now); e == nil {
		t.Fatal("MFA bypassed")
	}
}

func TestCASCannotResurrectRevokedRecord(t *testing.T) {
	s, _ := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{15}, 32))
	defer s.Close()
	before := map[string]string{"status": "published", "token": "old"}
	if e := s.CompareAndPutWithToken("outputs", "o", nil, before, "feeds", "", "old", "owner/o"); e != nil {
		t.Fatal(e)
	}
	revoked := map[string]string{"status": "revoked", "token": ""}
	if e := s.CompareAndPutWithToken("outputs", "o", before, revoked, "feeds", "old", "", ""); e != nil {
		t.Fatal(e)
	}
	staleRotate := map[string]string{"status": "published", "token": "new"}
	if e := s.CompareAndPutWithToken("outputs", "o", before, staleRotate, "feeds", "old", "new", "owner/o"); e != store.ErrConflict {
		t.Fatalf("stale rotation resurrected record: %v", e)
	}
	if _, e := s.LookupToken("feeds", "new"); e != store.ErrNotFound {
		t.Fatal("stale token became live")
	}
}
