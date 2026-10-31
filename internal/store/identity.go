package store

import (
	"database/sql"
	"fmt"
	"regexp"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"strings"
	"time"
)

type Account struct {
	Retired                bool      `json:"retired,omitempty"`
	PasswordChangeRequired bool      `json:"passwordChangeRequired,omitempty"`
	ID                     string    `json:"id"`
	Name                   string    `json:"name"`
	Username               string    `json:"username"`
	Role                   string    `json:"role"`
	PasswordHash           []byte    `json:"passwordHash"`
	Disabled               bool      `json:"disabled"`
	TOTPSecret             string    `json:"totpSecret,omitempty"`
	PendingTOTPSecret      string    `json:"pendingTotpSecret,omitempty"`
	PendingTOTPExpires     time.Time `json:"pendingTotpExpires,omitempty"`
	LastTOTPStep           int64     `json:"lastTotpStep"`
}
type Session struct {
	ID        string    `json:"id,omitempty"`
	Digest    string    `json:"digest"`
	AccountID string    `json:"accountId"`
	CSRFToken string    `json:"csrfToken"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type Invite struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Role       string     `json:"role"`
	Digest     string     `json:"digest"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	RedeemedAt *time.Time `json:"redeemedAt,omitempty"`
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.@+-]{2,127}$`)

func (s *Store) EnsureAdmin(username, password string) error {
	username = strings.ToLower(strings.TrimSpace(username))
	if !usernamePattern.MatchString(username) {
		return fmt.Errorf("invalid username")
	}
	hash, e := auth.HashPassword(password)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var id string
	e = s.db.QueryRow(`SELECT account_id FROM identities WHERE username=?`, username).Scan(&id)
	if e == nil {
		return nil
	}
	if e != sql.ErrNoRows {
		return e
	}
	records, e := s.list("accounts")
	if e != nil {
		return e
	}
	if len(records) > 0 {
		return fmt.Errorf("bootstrap only allowed before any local accounts exist")
	}
	a := Account{ID: "admin", Name: "Administrator", Username: username, Role: "admin", PasswordHash: hash}
	return s.createAccount(a, nil)
}
func (s *Store) createAccount(a Account, invite *Invite) error {
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if invite != nil {
		if !time.Now().Before(invite.ExpiresAt) {
			return fmt.Errorf("invite invalid or expired")
		}
		if e = s.compareRecordsTx(tx, []RecordCompare{{Kind: "invites", ID: invite.Digest, Expected: *invite}}, nil); e != nil {
			return fmt.Errorf("invite invalid or expired")
		}
	}
	if _, e = tx.Exec(`INSERT INTO identities(username,account_id) VALUES(?,?)`, a.Username, a.ID); e != nil {
		return fmt.Errorf("username unavailable")
	}
	put := func(k, id string, v any) error {
		return s.putTx(tx, k, id, v)
	}
	if e = put("accounts", a.ID, a); e != nil {
		return e
	}
	if e = put("users", a.ID, domain.User{ID: a.ID, Name: a.Name, Enabled: true}); e != nil {
		return e
	}
	if invite != nil {
		accepted := *invite
		now := time.Now().UTC()
		accepted.RedeemedAt = &now
		accepted.ID = accepted.Digest
		if e = put("invites", accepted.Digest, accepted); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) CreateInvite(name, role string, expires time.Time) (Invite, string, error) {
	if name == "" || (role != "user" && role != "admin") || !expires.After(time.Now()) {
		return Invite{}, "", fmt.Errorf("name, valid role and future expiry required")
	}
	token, e := auth.Token()
	if e != nil {
		return Invite{}, "", e
	}
	id, e := auth.Token()
	if e != nil {
		return Invite{}, "", e
	}
	v := Invite{ID: id, Name: name, Role: role, Digest: auth.Digest(token), ExpiresAt: expires}
	if e = s.Put("invites", v.Digest, v); e != nil {
		return Invite{}, "", e
	}
	return v, token, nil
}
func (s *Store) AcceptInvite(token, username, password string) (Account, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if !usernamePattern.MatchString(username) {
		return Account{}, fmt.Errorf("invalid username")
	}
	hash, e := auth.HashPassword(password)
	if e != nil {
		return Account{}, e
	}
	id, e := auth.Token()
	if e != nil {
		return Account{}, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var inv Invite
	digest := auth.Digest(token)
	if e = s.get("invites", digest, &inv); e != nil || inv.RedeemedAt != nil || !time.Now().Before(inv.ExpiresAt) {
		return Account{}, fmt.Errorf("invite invalid or expired")
	}
	a := Account{ID: "u_" + id, Name: inv.Name, Username: username, Role: inv.Role, PasswordHash: hash}
	if e = s.createAccount(a, &inv); e != nil {
		return Account{}, e
	}
	return a, nil
}

// Password verification stays outside the SQLite writer reservation. Every
// caller must compare expected inside its eventual security-state transaction.
func (s *Store) authenticate(username, password, totp string, now time.Time) (account, expected Account, err error) {
	var id string
	e := s.db.QueryRow(`SELECT account_id FROM identities WHERE username=?`, strings.ToLower(strings.TrimSpace(username))).Scan(&id)
	var a Account
	if e == nil {
		e = s.get("accounts", id, &a)
	}
	passwordOK := auth.CheckPassword(a.PasswordHash, password)
	if e != nil || a.Disabled || a.Retired || !passwordOK {
		return Account{}, Account{}, fmt.Errorf("invalid credentials")
	}
	expected = a
	if a.TOTPSecret != "" {
		step, valid := auth.MatchTOTPStep(a.TOTPSecret, totp, now)
		if !valid || step <= a.LastTOTPStep {
			return Account{}, Account{}, fmt.Errorf("invalid credentials")
		}
		a.LastTOTPStep = step
	}
	return a, expected, nil
}
func (s *Store) Authenticate(username, password, code string, now time.Time) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, expected, e := s.authenticate(username, password, code, now)
	if e != nil {
		return a, e
	}
	e = s.updateAuthenticatedAccount(expected, a)
	return a, e
}
func (s *Store) Login(username, password, code string, now time.Time) (Account, Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, expected, e := s.authenticate(username, password, code, now)
	if e != nil {
		return a, Session{}, "", e
	}
	session, token, e := s.commitSession(expected, a, now, false)
	return a, session, token, e
}
func (s *Store) NewSession(a Account, now time.Time) (Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.Disabled || a.Retired {
		return Session{}, "", ErrCredentials
	}
	return s.commitSession(a, a, now, false)
}

// updateAuthenticatedAccount fences password/MFA verification against a
// concurrent step consumption, disablement or enrollment on another handle.
func (s *Store) updateAuthenticatedAccount(expected, a Account) error {
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.compareRecordsTx(tx, []RecordCompare{{Kind: "accounts", ID: a.ID, Expected: expected}}, nil); err != nil {
		return err
	}
	if err = s.putTx(tx, "accounts", a.ID, a); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) ResolveSession(token string, now time.Time) (Account, Session, error) {
	var v Session
	var a Account
	if e := s.Get("sessions", auth.Digest(token), &v); e != nil || !now.Before(v.ExpiresAt) {
		return a, v, ErrNotFound
	}
	if e := s.Get("accounts", v.AccountID, &a); e != nil || a.Disabled || a.Retired {
		return a, v, ErrNotFound
	}
	return a, v, nil
}
