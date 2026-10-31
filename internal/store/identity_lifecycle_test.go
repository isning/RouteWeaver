package store_test

import (
	"bytes"
	"database/sql"
	"github.com/pquerna/otp/totp"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestPasswordChangeRevokesOldSessionsAndPreservesOtherAccount(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{19}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.EnsureAdmin("security-admin", "synthetic-old-password"); e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	a, current, old, e := s.Login("security-admin", "synthetic-old-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	_, _, other, e := s.Login(a.Username, "synthetic-old-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	_, invite, e := s.CreateInvite("Other", "user", now.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	b, e := s.AcceptInvite(invite, "other-user", "synthetic-other-password")
	if e != nil {
		t.Fatal(e)
	}
	_, unrelated, e := s.NewSession(b, now)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, _, e = s.ChangePassword(a.ID, current.Digest, "wrong-password", "synthetic-new-password", "", now); e == nil {
		t.Fatal("wrong reauthentication accepted")
	}
	if _, _, e = s.ResolveSession(old, now); e != nil {
		t.Fatal("failed change revoked session")
	}
	_, replacement, token, e := s.ChangePassword(a.ID, current.Digest, "synthetic-old-password", "synthetic-new-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	if token == old || replacement.CSRFToken == current.CSRFToken {
		t.Fatal("credentials not rotated")
	}
	for _, v := range []string{old, other} {
		if _, _, e = s.ResolveSession(v, now); e == nil {
			t.Fatal("old session survived password change")
		}
	}
	if _, _, e = s.ResolveSession(token, now); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(unrelated, now); e != nil {
		t.Fatal("cross-account session revoked", e)
	}
	if _, _, _, e = s.Login(a.Username, "synthetic-old-password", "", now); e == nil {
		t.Fatal("old password retained")
	}
	if _, _, _, e = s.Login(a.Username, "synthetic-new-password", "", now); e != nil {
		t.Fatal(e)
	}
	events, e := s.List("audit")
	if e != nil || len(events) != 1 {
		t.Fatalf("required audit missing: %d %v", len(events), e)
	}
}

func TestSecurityMutationsRequireFreshMFAAndLiveSession(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{22}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.EnsureAdmin("mfa-admin", "synthetic-admin-password")
	now := time.Unix(1800000000, 0)
	var a store.Account
	s.Get("accounts", "admin", &a)
	a.TOTPSecret = "JBSWY3DPEHPK3PXP"
	s.Put("accounts", a.ID, a)
	code, _ := totp.GenerateCode(a.TOTPSecret, now)
	_, session, token, e := s.Login(a.Username, "synthetic-admin-password", code, now)
	if e != nil {
		t.Fatal(e)
	}
	for _, proof := range []string{"", code} {
		if e = s.RevokeOtherSessions(a.ID, session.Digest, "synthetic-admin-password", proof, now); e == nil {
			t.Fatal("missing or replayed MFA accepted")
		}
	}
	next := now.Add(30 * time.Second)
	fresh, _ := totp.GenerateCode(a.TOTPSecret, next)
	if e = s.RevokeOtherSessions(a.ID, session.Digest, "synthetic-admin-password", fresh, next); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(token, next); e != nil {
		t.Fatal("current session revoked")
	}
	later := now.Add(13 * time.Hour)
	fresh, _ = totp.GenerateCode(a.TOTPSecret, later)
	if _, _, _, e = s.ChangePassword(a.ID, session.Digest, "synthetic-admin-password", "synthetic-new-password", fresh, later); e == nil {
		t.Fatal("expired session accepted as reauthentication proof")
	}
}

func TestSessionListBoundsAndHidesLegacyDigests(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{23}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.EnsureAdmin("session-admin", "synthetic-admin-password")
	var a store.Account
	s.Get("accounts", "admin", &a)
	now := time.Now()
	var latest store.Session
	for i := 0; i < 40; i++ {
		latest, _, e = s.NewSession(a, now.Add(time.Duration(i)*time.Second))
		if e != nil {
			t.Fatal(e)
		}
	}
	// Exercise backwards-compatible presentation-ID migration.
	latest.ID = ""
	if e = s.Put("sessions", latest.Digest, latest); e != nil {
		t.Fatal(e)
	}
	entries, e := s.Sessions(a.ID, latest.Digest, now.Add(time.Minute))
	if e != nil || len(entries) != 32 {
		t.Fatalf("unbounded sessions: %d %v", len(entries), e)
	}
	found := false
	for _, v := range entries {
		if v.ID == "" || v.ID == latest.Digest {
			t.Fatal("digest used as public ID")
		}
		if v.Current {
			found = true
		}
	}
	if !found {
		t.Fatal("current session missing")
	}
}

func TestOfflineRecoveryIsScopedAuditedAndRetainsMFAUnlessExplicit(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{24}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.EnsureAdmin("recover-admin", "synthetic-admin-password")
	now := time.Now()
	a, _, token, e := s.Login("recover-admin", "synthetic-admin-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	a.TOTPSecret = "JBSWY3DPEHPK3PXP"
	s.Put("accounts", a.ID, a)
	if e = s.RecoverAdministrator("missing-admin", "synthetic-temporary-password", "Synthetic recovery", true, now); e == nil {
		t.Fatal("created missing identity")
	}
	if e = s.RecoverAdministrator(a.Username, "synthetic-temporary-password", "Synthetic recovery", false, now); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.ResolveSession(token, now); e == nil {
		t.Fatal("old session survived recovery")
	}
	s.Get("accounts", a.ID, &a)
	if !a.PasswordChangeRequired || a.TOTPSecret == "" {
		t.Fatal("recovery skipped required change or silently cleared MFA")
	}
	if e = s.RecoverAdministrator(a.Username, "synthetic-other-password", "Synthetic lost MFA recovery", true, now); e != nil {
		t.Fatal(e)
	}
	id := a.ID
	a = store.Account{}
	s.Get("accounts", id, &a)
	if a.TOTPSecret != "" || !a.PasswordChangeRequired {
		t.Fatal("explicit recovery did not apply")
	}
	events, e := s.List("audit")
	if e != nil || len(events) != 2 {
		t.Fatal("recovery audit absent", e)
	}
}

func TestConcurrentAdministratorsCannotDisableEachOther(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{25}, 32)
	s, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.EnsureAdmin("first-admin", "synthetic-admin-password")
	_, invite, e := s.CreateInvite("Second", "admin", time.Now().Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	b, e := s.AcceptInvite(invite, "second-admin", "synthetic-admin-password")
	if e != nil {
		t.Fatal(e)
	}
	second, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	now := time.Now()
	a, sa, _, e := s.Login("first-admin", "synthetic-admin-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	_, sb, _, e := second.Login(b.Username, "synthetic-admin-password", "", now)
	if e != nil {
		t.Fatal(e)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	action := store.SecurityAction{Action: "disable", CurrentPassword: "synthetic-admin-password", Reason: "Synthetic concurrent disable"}
	go func() { <-start; _, e := s.AccountSecurity(a.ID, sa.Digest, b.ID, action, now); results <- e }()
	go func() { <-start; _, e := second.AccountSecurity(b.ID, sb.Digest, a.ID, action, now); results <- e }()
	close(start)
	successes := 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected one serialized winner, got %d", successes)
	}
	s.Get("accounts", a.ID, &a)
	s.Get("accounts", b.ID, &b)
	if a.Disabled == b.Disabled {
		t.Fatalf("administrator continuity violated: %v %v", a.Disabled, b.Disabled)
	}
}

func TestSecurityAuditFailureRollsBackPasswordAndSessionChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	s, e := store.Open(path, bytes.Repeat([]byte{26}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.EnsureAdmin("audit-admin", "synthetic-admin-password")
	now := time.Now()
	a, session, token, e := s.Login("audit-admin", "synthetic-admin-password", "", now)
	if e != nil {
		t.Fatal(e)
	}

	_, invite, e := s.CreateInvite("Audit target", "user", now.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	target, e := s.AcceptInvite(invite, "audit-target", "synthetic-target-password")
	if e != nil {
		t.Fatal(e)
	}
	_, targetToken, e := s.NewSession(target, now)
	if e != nil {
		t.Fatal(e)
	}

	fault, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	defer fault.Close()
	if _, e = fault.Exec(`CREATE TRIGGER reject_security_audit BEFORE INSERT ON records WHEN NEW.kind='audit' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`); e != nil {
		t.Fatal(e)
	}

	if _, e = s.AccountSecurity(a.ID, session.Digest, target.ID, store.SecurityAction{Action: "disable", CurrentPassword: "synthetic-admin-password", Reason: "Synthetic audit failure"}, now); e == nil {
		t.Fatal("unrecorded disable committed")
	}
	if _, _, e = s.ResolveSession(targetToken, now); e != nil {
		t.Fatal("failed admin audit revoked target session", e)
	}

	if _, _, _, e = s.ChangePassword(a.ID, session.Digest, "synthetic-admin-password", "synthetic-new-password", "", now); e == nil {
		t.Fatal("unrecorded security change succeeded")
	}
	if _, _, e = s.ResolveSession(token, now); e != nil {
		t.Fatal("failed audit revoked session", e)
	}
	if _, _, _, e = s.Login(a.Username, "synthetic-admin-password", "", now); e != nil {
		t.Fatal("failed audit changed password", e)
	}
}
