package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

func TestConcurrentHTTPLoginConsumesOneTOTPStepWithoutLeakingConflict(t *testing.T) {
	path, key := filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{74}, 32)
	var handles []*store.Store
	for range 2 {
		s, err := store.Open(path, key)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		handles = append(handles, s)
	}
	const password = "synthetic-http-concurrent-password"
	if err := handles[0].EnsureAdmin("operator", password); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	secret, _, err := handles[0].BeginMFA("admin", password, now.Add(-30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	prior, err := totp.GenerateCode(secret, now.Add(-30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = handles[0].EnableMFA("admin", prior, now.Add(-30*time.Second)); err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]string{"username": "operator", "password": password, "totp": code})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	for _, s := range handles {
		h := httpapi.New(s, render.Default(), "", "")
		go func() {
			<-start
			r := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			responses <- w
		}()
	}
	close(start)
	accepted := 0
	for range 2 {
		w := <-responses
		if w.Code == http.StatusOK {
			accepted++
			if len(w.Result().Cookies()) != 1 {
				t.Fatal("successful login did not establish its session")
			}
		} else if w.Code != http.StatusUnauthorized || w.Body.String() != "{\"detail\":\"invalid credentials\"}\n" || len(w.Result().Cookies()) != 0 {
			t.Fatalf("rejected login did not use the fixed unauthenticated response (status %d)", w.Code)
		}
	}
	if accepted != 1 {
		t.Fatalf("one TOTP step authenticated %d HTTP callers; want exactly one", accepted)
	}
}
