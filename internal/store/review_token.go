package store

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// ReviewToken binds private record content without exposing an offline-guessable
// plain digest. It is not an authorization token; callers still authenticate and
// compare every captured input atomically. The subkey is never persisted.
func (s *Store) ReviewToken(purpose string, value any) (string, error) {
	if purpose == "" || len(s.reviewKey) != 32 {
		return "", fmt.Errorf("review purpose required")
	}
	raw, e := json.Marshal(value)
	if e != nil {
		return "", e
	}
	var canonical any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if e = decoder.Decode(&canonical); e != nil {
		return "", e
	}
	raw, e = json.Marshal(canonical)
	if e != nil {
		return "", e
	}
	mac := hmac.New(sha256.New, s.reviewKey)
	mac.Write([]byte(purpose))
	mac.Write([]byte{0})
	mac.Write(raw)
	return "rw1_" + hex.EncodeToString(mac.Sum(nil)), nil
}
