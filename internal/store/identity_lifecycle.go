package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"routeweaver/internal/auth"
	"sort"
	"strings"
	"time"
)

var ErrInvalidSecurityAction = errors.New("invalid security action")
var ErrCredentials = errors.New("invalid credentials")
var ErrAccountProtected = errors.New("account action is not allowed")

// SecurityAction carries fresh credentials, never a reusable step-up bearer proof.
type SecurityAction struct {
	Action          string `json:"action"`
	CurrentPassword string `json:"currentPassword"`
	TOTP            string `json:"totp,omitempty"`
	NewPassword     string `json:"newPassword,omitempty"`
	Reason          string `json:"reason"`
}

type SessionView struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expiresAt"`
	Current   bool      `json:"current"`
}

func (s *Store) verifyAccount(id, password, code string, now time.Time) (Account, Account, error) {
	var a Account
	if e := s.get("accounts", id, &a); e != nil {
		return a, a, ErrCredentials
	}
	updated, expected, e := s.authenticate(a.Username, password, code, now)
	if e != nil {
		return a, a, ErrCredentials
	}
	return updated, expected, nil
}
func (s *Store) requireSessionTx(tx *sql.Tx, owner, digest string, now time.Time) error {
	var v Session
	if e := s.getTx(tx, "sessions", digest, &v); e != nil || v.AccountID != owner || !now.Before(v.ExpiresAt) {
		return ErrCredentials
	}
	return nil
}
func (s *Store) securityAuditTx(tx *sql.Tx, actor, action, target, reason string, now time.Time) error {
	id, e := auth.Token()
	if e != nil {
		return e
	}
	// Reason is operator-provided context, never credentials. Limit its stored size.
	return s.putTx(tx, "audit", id, struct {
		AuditEvent
		Reason string `json:"reason,omitempty"`
	}{AuditEvent{id, actor, action, target, now.UTC()}, reason})
}
func (s *Store) revokeSessionsTx(tx *sql.Tx, owner, keep string) error {
	all, e := s.listTx(tx, "sessions")
	if e != nil {
		return e
	}
	for _, raw := range all {
		var v Session
		if e = json.Unmarshal(raw, &v); e != nil {
			return e
		}
		if v.AccountID == owner && v.Digest != keep {
			if _, e = tx.Exec(`DELETE FROM records WHERE kind='sessions' AND id=?`, v.Digest); e != nil {
				return e
			}
		}
	}
	return nil
}
func newSecuritySession(a Account, now time.Time) (Session, string, error) {
	token, e := auth.Token()
	if e != nil {
		return Session{}, "", e
	}
	csrf, e := auth.Token()
	if e != nil {
		return Session{}, "", e
	}
	id, e := auth.Token()
	if e != nil {
		return Session{}, "", e
	}
	return Session{ID: id, Digest: auth.Digest(token), AccountID: a.ID, CSRFToken: csrf, ExpiresAt: now.Add(12 * time.Hour)}, token, nil
}

func (s *Store) ChangePassword(id, digest, currentPassword, newPassword, code string, now time.Time) (Account, Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, expected, e := s.verifyAccount(id, currentPassword, code, now)
	if e != nil {
		return Account{}, Session{}, "", e
	}
	if currentPassword == newPassword {
		return Account{}, Session{}, "", fmt.Errorf("%w: new password must differ from current password", ErrInvalidSecurityAction)
	}
	hash, e := auth.HashPassword(newPassword)
	if e != nil {
		return Account{}, Session{}, "", fmt.Errorf("%w: %v", ErrInvalidSecurityAction, e)
	}
	a.PasswordHash = hash
	a.PasswordChangeRequired = false
	session, token, e := newSecuritySession(a, now)
	if e != nil {
		return a, Session{}, "", e
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return a, Session{}, "", e
	}
	defer tx.Rollback()
	if e = s.requireSessionTx(tx, id, digest, now); e != nil {
		return a, Session{}, "", e
	}
	if e = s.compareRecordsTx(tx, []RecordCompare{{Kind: "accounts", ID: id, Expected: expected}}, nil); e != nil {
		return a, Session{}, "", e
	}
	if e = s.revokeSessionsTx(tx, id, ""); e != nil {
		return a, Session{}, "", e
	}
	if e = s.putTx(tx, "accounts", id, a); e != nil {
		return a, Session{}, "", e
	}
	if e = s.putTx(tx, "sessions", session.Digest, session); e != nil {
		return a, Session{}, "", e
	}
	if e = s.securityAuditTx(tx, id, "account.password-changed", id, "", now); e != nil {
		return a, Session{}, "", e
	}
	if e = tx.Commit(); e != nil {
		return a, Session{}, "", e
	}
	return a, session, token, nil
}

// Sessions returns only the owner's unexpired sessions. Legacy sessions receive
// independently random presentation IDs; token digests are never exposed.
func (s *Store) Sessions(owner, currentDigest string, now time.Time) ([]SessionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	if e = s.requireSessionTx(tx, owner, currentDigest, now); e != nil {
		return nil, e
	}
	if e = s.pruneSessionsTx(tx, owner, currentDigest, now, 32); e != nil {
		return nil, e
	}
	all, e := s.listTx(tx, "sessions")
	if e != nil {
		return nil, e
	}
	out := []SessionView{}
	for _, raw := range all {
		var v Session
		if e = json.Unmarshal(raw, &v); e != nil {
			return nil, e
		}
		if v.AccountID != owner {
			continue
		}
		if !now.Before(v.ExpiresAt) {
			if _, e = tx.Exec(`DELETE FROM records WHERE kind='sessions' AND id=?`, v.Digest); e != nil {
				return nil, e
			}
			continue
		}
		if v.ID == "" {
			v.ID, e = auth.Token()
			if e != nil {
				return nil, e
			}
			if e = s.putTx(tx, "sessions", v.Digest, v); e != nil {
				return nil, e
			}
		}
		out = append(out, SessionView{v.ID, v.ExpiresAt, v.Digest == currentDigest})
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return out, nil
}
func (s *Store) RevokeSession(owner, currentDigest, id string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return false, e
	}
	defer tx.Rollback()
	if e = s.requireSessionTx(tx, owner, currentDigest, now); e != nil {
		return false, e
	}
	all, e := s.listTx(tx, "sessions")
	if e != nil {
		return false, e
	}
	for _, raw := range all {
		var v Session
		if e = json.Unmarshal(raw, &v); e != nil {
			return false, e
		}
		if v.AccountID != owner || v.ID == "" || v.ID != id || !now.Before(v.ExpiresAt) {
			continue
		}
		if _, e = tx.Exec(`DELETE FROM records WHERE kind='sessions' AND id=?`, v.Digest); e != nil {
			return false, e
		}
		if e = s.securityAuditTx(tx, owner, "session.revoked", owner, "", now); e != nil {
			return false, e
		}
		return v.Digest == currentDigest, tx.Commit()
	}
	return false, ErrNotFound
}
func (s *Store) RevokeOtherSessions(owner, digest, password, code string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, expected, e := s.verifyAccount(owner, password, code, now)
	if e != nil {
		return e
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = s.requireSessionTx(tx, owner, digest, now); e != nil {
		return e
	}
	if e = s.compareRecordsTx(tx, []RecordCompare{{Kind: "accounts", ID: owner, Expected: expected}}, nil); e != nil {
		return e
	}
	if e = s.putTx(tx, "accounts", owner, a); e != nil {
		return e
	}
	if e = s.revokeSessionsTx(tx, owner, digest); e != nil {
		return e
	}
	if e = s.securityAuditTx(tx, owner, "sessions.revoked-others", owner, "", now); e != nil {
		return e
	}
	return tx.Commit()
}

func (s *Store) AccountSecurity(actor, digest, target string, in SecurityAction, now time.Time) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, expected, e := s.verifyAccount(actor, in.CurrentPassword, in.TOTP, now)
	if e != nil {
		return Account{}, e
	}
	if a.Role != "admin" || a.PasswordChangeRequired || actor == target {
		return Account{}, ErrAccountProtected
	}
	reason := strings.TrimSpace(in.Reason)
	if len(reason) < 3 || len(reason) > 500 {
		return Account{}, fmt.Errorf("%w: reason must be 3–500 bytes", ErrInvalidSecurityAction)
	}
	var hash []byte
	if in.Action == "reset-password" {
		hash, e = auth.HashPassword(in.NewPassword)
		if e != nil {
			return Account{}, fmt.Errorf("%w: %v", ErrInvalidSecurityAction, e)
		}
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return Account{}, e
	}
	defer tx.Rollback()
	if e = s.requireSessionTx(tx, actor, digest, now); e != nil {
		return Account{}, e
	}
	if e = s.compareRecordsTx(tx, []RecordCompare{{Kind: "accounts", ID: actor, Expected: expected}}, nil); e != nil {
		return Account{}, e
	}
	var v Account
	if e = s.getTx(tx, "accounts", target, &v); e != nil {
		return v, e
	}
	if v.Retired {
		return v, ErrAccountProtected
	}
	switch in.Action {
	case "disable":
		v.Disabled = true
	case "enable":
		v.Disabled = false
	case "retire":
		v.Disabled = true
		v.Retired = true
	case "reset-password":
		v.PasswordHash = hash
		v.PasswordChangeRequired = true
	case "reset-mfa":
		v.TOTPSecret = ""
		v.PendingTOTPSecret = ""
		v.PendingTOTPExpires = time.Time{}
		v.LastTOTPStep = 0
	default:
		return v, fmt.Errorf("%w: unsupported account security action", ErrInvalidSecurityAction)
	}
	if v.Role == "admin" && (in.Action == "disable" || in.Action == "retire") {
		all, e := s.listTx(tx, "accounts")
		if e != nil {
			return v, e
		}
		active := 0
		for _, raw := range all {
			var other Account
			if e = json.Unmarshal(raw, &other); e != nil {
				return v, e
			}
			if other.ID != target && other.Role == "admin" && !other.Disabled && !other.Retired {
				active++
			}
		}
		if active == 0 {
			return v, ErrAccountProtected
		}
	}
	if e = s.putTx(tx, "accounts", actor, a); e != nil {
		return v, e
	}
	if e = s.putTx(tx, "accounts", target, v); e != nil {
		return v, e
	}
	if e = s.revokeSessionsTx(tx, target, ""); e != nil {
		return v, e
	}
	if e = s.securityAuditTx(tx, actor, "account."+in.Action, target, reason, now); e != nil {
		return v, e
	}
	return v, tx.Commit()
}

// RecoverAdministrator is only driven by the offline CLI holding the same
// exclusive process lock as the server. It cannot create identities or unretire
// accounts, and requires the encryption key through normal Store.Open.
func (s *Store) RecoverAdministrator(username, password, reason string, disableMFA bool, now time.Time) error {
	reason = strings.TrimSpace(reason)
	if len(reason) < 3 || len(reason) > 500 {
		return fmt.Errorf("reason must be 3–500 bytes")
	}
	hash, e := auth.HashPassword(password)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var id string
	if e = tx.QueryRow(`SELECT account_id FROM identities WHERE username=?`, strings.ToLower(strings.TrimSpace(username))).Scan(&id); e != nil {
		return ErrAccountProtected
	}
	var a Account
	if e = s.getTx(tx, "accounts", id, &a); e != nil {
		return e
	}
	if a.Role != "admin" || a.Retired {
		return ErrAccountProtected
	}
	a.PasswordHash = hash
	a.PasswordChangeRequired = true
	a.Disabled = false
	if disableMFA {
		a.TOTPSecret = ""
		a.PendingTOTPSecret = ""
		a.PendingTOTPExpires = time.Time{}
		a.LastTOTPStep = 0
	}
	if e = s.putTx(tx, "accounts", id, a); e != nil {
		return e
	}
	if e = s.revokeSessionsTx(tx, id, ""); e != nil {
		return e
	}
	if e = s.securityAuditTx(tx, "offline-operator", "account.offline-recovery", id, reason, now); e != nil {
		return e
	}
	return tx.Commit()
}

// Bound active sessions per account and opportunistically remove expired ones.
// keep protects the authenticated current session during legacy migration/listing.
func (s *Store) pruneSessionsTx(tx *sql.Tx, owner, keep string, now time.Time, maximum int) error {
	all, e := s.listTx(tx, "sessions")
	if e != nil {
		return e
	}
	active := []Session{}
	kept := 0
	remove := func(digest string) error {
		_, e := tx.Exec(`DELETE FROM records WHERE kind='sessions' AND id=?`, digest)
		return e
	}
	for _, raw := range all {
		var v Session
		if e = json.Unmarshal(raw, &v); e != nil {
			return e
		}
		if v.AccountID != owner {
			continue
		}
		if !now.Before(v.ExpiresAt) {
			if e = remove(v.Digest); e != nil {
				return e
			}
			continue
		}
		if v.Digest == keep {
			kept++
			continue
		}
		active = append(active, v)
	}
	sort.Slice(active, func(i, j int) bool {
		if active[i].ExpiresAt.Equal(active[j].ExpiresAt) {
			return active[i].Digest < active[j].Digest
		}
		return active[i].ExpiresAt.Before(active[j].ExpiresAt)
	})
	for len(active)+kept > maximum {
		if e = remove(active[0].Digest); e != nil {
			return e
		}
		active = active[1:]
	}
	return nil
}
