package httpapi_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"testing"
)

func TestAuthorizationBeforeState(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{4}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	h := httpapi.New(s, render.Default(), "01234567890123456789012345678901", "")
	for _, tc := range []struct {
		token string
		want  int
	}{{"", 401}, {"wrong", 401}, {"01234567890123456789012345678901", 200}} {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("want %d got %d: %s", tc.want, w.Code, w.Body.String())
		}
	}
	_ = http.MethodGet
}
