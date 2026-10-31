// Package auth uses audited library primitives; tokens are opaque random values,
// passwords use bcrypt, MFA uses RFC 6238 TOTP through pquerna/otp.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
	"time"
)

func Token() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func Digest(token string) string { h := sha256.Sum256([]byte(token)); return hex.EncodeToString(h[:]) }
func HashPassword(password string) ([]byte, error) {
	if len(password) < 12 || len(password) > 72 {
		return nil, fmt.Errorf("password must be 12–72 bytes")
	}
	return bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
}

// This valid cost-10 dummy hash is not an account credential. Invalid or missing
// hashes still incur exactly one product-cost bcrypt comparison. Password
// creation always uses DefaultCost; untrusted imported cost values cannot cause
// unbounded CPU work or bypass the product's password length policy.
const dummyPasswordHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

func CheckPassword(hash []byte, password string) bool {
	cost, err := bcrypt.Cost(hash)
	valid := err == nil && cost == bcrypt.DefaultCost && len(password) <= 72
	if err != nil || cost != bcrypt.DefaultCost {
		hash = []byte(dummyPasswordHash)
	}
	if len(password) > 72 {
		password = "invalid-overlong-password"
	}
	comparisonErr := bcrypt.CompareHashAndPassword(hash, []byte(password))
	if comparisonErr != nil && !errors.Is(comparisonErr, bcrypt.ErrMismatchedHashAndPassword) {
		// Cost validates only the header. Malformed salts/encodings can fail
		// before bcrypt work; do one bounded dummy comparison before rejecting.
		_ = bcrypt.CompareHashAndPassword([]byte(dummyPasswordHash), []byte(password))
		return false
	}
	return valid && comparisonErr == nil
}
func ValidateTOTP(secret, code string, now time.Time) bool {
	ok, err := totp.ValidateCustom(code, secret, now, totp.ValidateOpts{Period: 30, Skew: 1, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
	return err == nil && ok
}
func GenerateTOTP(account string) (string, string, error) {
	key, e := totp.Generate(totp.GenerateOpts{Issuer: "RouteWeaver", AccountName: account})
	if e != nil {
		return "", "", e
	}
	return key.Secret(), key.URL(), nil
}

// MatchTOTPStep records the actual accepted time step, including tolerated skew,
// so a code cannot be replayed once the wall clock crosses another boundary.
func MatchTOTPStep(secret, code string, now time.Time) (int64, bool) {
	for _, offset := range []int64{0, -1, 1} {
		step := now.Unix()/30 + offset
		ok, e := totp.ValidateCustom(code, secret, time.Unix(step*30, 0), totp.ValidateOpts{Period: 30, Skew: 0, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
		if e == nil && ok {
			return step, true
		}
	}
	return 0, false
}
