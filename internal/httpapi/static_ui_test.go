package httpapi_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"testing"
)

const uiManifest = `{
  "index.html": {"file":"assets/app-A1b2C3d4.js","isEntry":true,"css":["assets/app-E5f6G7h8.css"],"assets":["assets/geist-I9j0K1l2.woff2"]},
  "route.tsx": {"file":"assets/route-M3n4O5p6.js","isDynamicEntry":true},
  "unhashed": {"file":"assets/unhashed.js"},
  "outside": {"file":"outside-Q7r8S9t0.js"},
  "normalized": {"file":"assets/../assets/alias-U1v2W3x4.js"}
}`

func staticUI(t *testing.T, manifest string) (http.Handler, string) {
	t.Helper()
	directory := t.TempDir()
	files := map[string]string{
		"index.html":                  "<!doctype html><title>Current console</title>",
		"assets/app-A1b2C3d4.js":      "console.log('current console')",
		"assets/route-M3n4O5p6.js":    "export default 'route'",
		"assets/app-E5f6G7h8.css":     "body{color:black}",
		"assets/geist-I9j0K1l2.woff2": "synthetic-font-bytes",
		"assets/unlisted-Y5z6A7b8.js": "unlisted",
		"assets/unhashed.js":          "unhashed",
		"outside-Q7r8S9t0.js":         "outside assets",
		"assets/alias-U1v2W3x4.js":    "normalized alias",
	}
	if manifest != "" {
		files[".vite/manifest.json"] = manifest
	}
	for name, body := range files {
		path := filepath.Join(directory, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{4}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return httpapi.New(s, render.Default(), "", directory), directory
}

func staticRead(h http.Handler, target string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
	return w
}

func TestBuiltUIAssetsAreCacheableWithoutCachingPrivateResponses(t *testing.T) {
	h, _ := staticUI(t, uiManifest)
	for _, path := range []string{"/assets/app-A1b2C3d4.js", "/assets/app-E5f6G7h8.css", "/assets/geist-I9j0K1l2.woff2", "/assets/route-M3n4O5p6.js"} {
		t.Run(path, func(t *testing.T) {
			w := staticRead(h, path)
			if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatalf("built asset should be cacheable: %d %v", w.Code, w.Header())
			}
			if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("X-Frame-Options") != "DENY" || w.Header().Get("Content-Security-Policy") == "" {
				t.Fatal("static cache handling removed security headers")
			}
		})
	}
	for _, path := range []string{"/", "/index.html", "/subscriptions", "/api/auth/me", "/api/unknown", "/feed/not-a-real-token", "/assets/missing-C9d0E1f2.js", "/.vite/manifest.json", "/assets/unlisted-Y5z6A7b8.js", "/assets/unhashed.js", "/outside-Q7r8S9t0.js", "/assets/alias-U1v2W3x4.js", "/assets//app-A1b2C3d4.js", "/assets/../assets/app-A1b2C3d4.js", "/assets%2Fapp-A1b2C3d4.js"} {
		t.Run("uncached"+path, func(t *testing.T) {
			w := staticRead(h, path)
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response must remain private/uncached: %d %v", w.Code, w.Header())
			}
		})
	}
}

func TestUIWithoutValidBuildManifestRemainsUncached(t *testing.T) {
	for _, manifest := range []string{"", "{broken", `{ "index.html": {"file": "assets/app-A1b2C3d4.js"} }`} {
		h, _ := staticUI(t, manifest)
		w := staticRead(h, "/assets/app-A1b2C3d4.js")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unverified artifact was cacheable: %d %v", w.Code, w.Header())
		}
	}
}

func TestBuiltUIAssetErrorsAndChangedDeploymentsRemainUncached(t *testing.T) {
	h, directory := staticUI(t, uiManifest)
	// Invalid byte ranges are errors, not cacheable copies of a valid resource.
	r := httptest.NewRequest(http.MethodGet, "/assets/app-A1b2C3d4.js", nil)
	r.Header.Set("Range", "bytes=999999-")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 416 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("error became cacheable: %d %v", w.Code, w.Header())
	}
	r = httptest.NewRequest(http.MethodGet, "/assets/app-A1b2C3d4.js", nil)
	r.Header.Set("If-Match", `"different-representation"`)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusPreconditionFailed || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("precondition error became cacheable: %d %v", w.Code, w.Header())
	}
	// If an operator overwrites a fingerprinted path, no new response may claim it
	// is immutable. Previously cached bytes cannot be revoked by this process.
	assetPath := filepath.Join(directory, "assets/app-A1b2C3d4.js")
	previous, err := os.Stat(assetPath)
	if err != nil {
		t.Fatal(err)
	}
	changed := bytes.Repeat([]byte("x"), int(previous.Size()))
	if err := os.WriteFile(assetPath, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(assetPath, previous.ModTime(), previous.ModTime()); err != nil {
		t.Fatal(err)
	}
	w = staticRead(h, "/assets/app-A1b2C3d4.js")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !bytes.Equal(w.Body.Bytes(), changed) {
		t.Fatalf("changed bytes were treated as immutable: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("new deployment index"), 0600); err != nil {
		t.Fatal(err)
	}
	w = staticRead(h, "/")
	if w.Body.String() != "new deployment index" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("HTML deployment changes were cached")
	}
	if err := os.Remove(filepath.Join(directory, "assets/route-M3n4O5p6.js")); err != nil {
		t.Fatal(err)
	}
	w = staticRead(h, "/assets/route-M3n4O5p6.js")
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing asset fallback was cached")
	}
}

func TestBuiltUIAssetsPreserveConditionalAndPartialReads(t *testing.T) {
	h, _ := staticUI(t, uiManifest)
	first := staticRead(h, "/assets/app-A1b2C3d4.js")
	for _, tc := range []struct {
		header string
		value  string
		status int
	}{
		{"If-Modified-Since", first.Header().Get("Last-Modified"), http.StatusNotModified},
		{"Range", "bytes=0-6", http.StatusPartialContent},
	} {
		r := httptest.NewRequest(http.MethodGet, "/assets/app-A1b2C3d4.js", nil)
		r.Header.Set(tc.header, tc.value)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Fatalf("%s lost HTTP semantics: %d %v", tc.header, w.Code, w.Header())
		}
		if tc.status == http.StatusPartialContent && w.Body.String() != "console" {
			t.Fatalf("incorrect byte range: %q", w.Body.String())
		}
	}
}

func TestBuiltUIAssetSymlinkReplacementIsNotCacheable(t *testing.T) {
	h, directory := staticUI(t, uiManifest)
	path := filepath.Join(directory, "assets/app-A1b2C3d4.js")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "replacement.js")
	if err := os.WriteFile(target, body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	w := staticRead(h, "/assets/app-A1b2C3d4.js")
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("symlink replacement was cacheable")
	}
}

func TestUncachedUIErrorsKeepNoStore(t *testing.T) {
	h, directory := staticUI(t, uiManifest)
	for _, path := range []string{"/", "/subscriptions", "/assets/unlisted-Y5z6A7b8.js"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Range", "bytes=999999-")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusRequestedRangeNotSatisfiable {
			t.Fatalf("expected invalid range for %s, got %d", path, w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("uncached %s error lost no-store: %d %v", path, w.Code, w.Header())
		}
	}
	if err := os.Remove(filepath.Join(directory, "index.html")); err != nil {
		t.Fatal(err)
	}
	w := staticRead(h, "/subscriptions")
	if w.Code != http.StatusNotFound || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing SPA index lost no-store: %d %v", w.Code, w.Header())
	}
}
