package store

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/auth"
	"time"
)

func (s *Store) BeginMFA(id, password string, now time.Time) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var a Account
	if e := s.get("accounts", id, &a); e != nil {
		return "", "", e
	}
	if a.Role != "admin" || a.Disabled || a.Retired || !auth.CheckPassword(a.PasswordHash, password) {
		return "", "", fmt.Errorf("invalid credentials")
	}
	if a.TOTPSecret != "" {
		return "", "", fmt.Errorf("MFA already enabled")
	}
	expected := a
	secret, uri, e := auth.GenerateTOTP(a.Username)
	if e != nil {
		return "", "", e
	}
	a.PendingTOTPSecret = secret
	a.PendingTOTPExpires = now.Add(10 * time.Minute)
	return secret, uri, s.updateAuthenticatedAccount(expected, a)
}
func (s *Store) EnableMFA(id, code string, now time.Time) (Account, Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var a Account
	if e := s.get("accounts", id, &a); e != nil {
		return a, Session{}, "", e
	}
	step, valid := auth.MatchTOTPStep(a.PendingTOTPSecret, code, now)
	if a.Disabled || a.Retired || a.Role != "admin" || a.TOTPSecret != "" || a.PendingTOTPSecret == "" || !now.Before(a.PendingTOTPExpires) || !valid {
		return a, Session{}, "", fmt.Errorf("MFA enrollment expired, already completed, or invalid code")
	}
	expected := a
	a.TOTPSecret = a.PendingTOTPSecret
	a.PendingTOTPSecret = ""
	a.PendingTOTPExpires = time.Time{}
	a.LastTOTPStep = step
	session, token, e := s.commitSession(expected, a, now, true)
	return a, session, token, e
}

// commitSession atomically persists accepted MFA step and the new session. When
// enrolling MFA, all older sessions are revoked in the same transaction.
func (s *Store) commitSession(expected, a Account, now time.Time, revoke bool) (Session, string, error) {
	session, token, e := newSecuritySession(a, now)
	if e != nil {
		return Session{}, "", e
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return Session{}, "", e
	}
	defer tx.Rollback()
	if e = s.compareRecordsTx(tx, []RecordCompare{{Kind: "accounts", ID: a.ID, Expected: expected}}, nil); e != nil {
		return Session{}, "", e
	}
	if !revoke {
		if e = s.pruneSessionsTx(tx, a.ID, "", now, 31); e != nil {
			return Session{}, "", e
		}
	}
	toDelete := []string{}
	if revoke {
		all, e := s.listTx(tx, "sessions")
		if e != nil {
			return Session{}, "", e
		}
		for _, b := range all {
			var v Session
			if e = json.Unmarshal(b, &v); e != nil {
				return Session{}, "", e
			}
			if v.AccountID == a.ID {
				toDelete = append(toDelete, v.Digest)
			}
		}
	}
	ab, e := s.seal("accounts", a.ID, a)
	if e != nil {
		return Session{}, "", e
	}
	sb, e := s.seal("sessions", session.Digest, session)
	if e != nil {
		return Session{}, "", e
	}
	for _, digest := range toDelete {
		if _, e = tx.Exec(`DELETE FROM records WHERE kind='sessions' AND id=?`, digest); e != nil {
			return Session{}, "", e
		}
	}
	if _, e = tx.Exec(`UPDATE records SET data=? WHERE kind='accounts' AND id=?`, ab, a.ID); e != nil {
		return Session{}, "", e
	}
	if _, e = tx.Exec(`INSERT INTO records(kind,id,data) VALUES('sessions',?,?)`, session.Digest, sb); e != nil {
		return Session{}, "", e
	}
	if e = tx.Commit(); e != nil {
		return Session{}, "", e
	}
	return session, token, nil
}
