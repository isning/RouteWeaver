//go:build oidc_browser_acceptance

package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Production React login UI against a test-only HTTPS IdP and real HTTP auth.
// Only the child browser trusts the exact fixture TLS public key; no OS trust
// or production security settings change. No traces or token artifacts.
func TestOIDCBrowserCrossSite(t *testing.T) {
	for _, mfa := range []bool{false, true} {
		name := "without_MFA"
		if mfa {
			name = "with_MFA"
		}
		t.Run(name, func(t *testing.T) {
			f := newOIDCFixtureForBrowser(t, true)
			dist, err := filepath.Abs("../../web/dist")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
				t.Fatal("build production web assets before browser acceptance:", err)
			}
			api := f.app.Config.Handler
			assets := http.FileServer(http.Dir(dist))
			f.app.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/") {
					assets.ServeHTTP(w, r)
					return
				}
				api.ServeHTTP(w, r)
			})
			secret := ""
			if mfa {
				secret = "JBSWY3DPEHPK3PXP"
				a := f.account
				a.TOTPSecret = secret
				if err := f.db.Put("accounts", a.ID, a); err != nil {
					t.Fatal(err)
				}
			}
			sum := sha256.Sum256(f.app.Certificate().RawSubjectPublicKeyInfo)
			if sum != sha256.Sum256(f.idp.Certificate().RawSubjectPublicKeyInfo) {
				t.Fatal("fixture TLS keys differ")
			}
			data, err := json.Marshal(map[string]any{"origin": f.app.URL, "issuer": f.idp.URL, "spki": base64.StdEncoding.EncodeToString(sum[:]), "totpSecret": secret, "accountID": f.account.ID})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
			defer cancel()
			path, err := filepath.Abs("../../web/scripts/oidc-browser.mjs")
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, "node", path)
			cmd.Env = append(os.Environ(), "ROUTEWEAVER_OIDC_FIXTURE="+string(data))
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("browser acceptance failed: %v\n%s", err, output)
			}
			t.Log(string(output))
		})
	}
}
