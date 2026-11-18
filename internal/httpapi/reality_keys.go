package httpapi

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
)

func (h *server) generateRealityKeys(w http.ResponseWriter, _ *http.Request) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		fail(w, http.StatusInternalServerError, "无法生成 REALITY 密钥")
		return
	}
	var shortID [8]byte
	if _, err := rand.Read(shortID[:]); err != nil {
		fail(w, http.StatusInternalServerError, "无法生成 REALITY Short ID")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"privateKey": base64.RawURLEncoding.EncodeToString(key.Bytes()),
		"publicKey":  base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		"shortId":    hex.EncodeToString(shortID[:]),
	})
}
