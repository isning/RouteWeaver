package store

import (
	"routeweaver/internal/auth"
	"time"
)

// CompleteOIDCLogin is called only after verified issuer/subject mapping. The
// snapshot fences the whole login against account/security changes during MFA.
// OIDC never substitutes for locally configured MFA or clears password reset.
func (s *Store) CompleteOIDCLogin(expected Account, code string, now time.Time) (Account, Session, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if expected.ID == "" || expected.Disabled || expected.Retired {
		return Account{}, Session{}, "", ErrCredentials
	}
	a := expected
	if a.TOTPSecret != "" {
		step, ok := auth.MatchTOTPStep(a.TOTPSecret, code, now)
		if !ok || step <= a.LastTOTPStep {
			return Account{}, Session{}, "", ErrCredentials
		}
		a.LastTOTPStep = step
	}
	session, token, err := s.commitSession(expected, a, now, false)
	if err != nil {
		return Account{}, Session{}, "", ErrCredentials
	}
	return a, session, token, nil
}
