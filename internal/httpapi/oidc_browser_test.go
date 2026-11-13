//go:build oidc_browser_acceptance

package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Real browser HTTP/cookie seam, not a test of the production React login UI.
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
