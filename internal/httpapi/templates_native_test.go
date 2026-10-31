package httpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// This checks the actual selected/followed profile with each pinned native
// parser before publishing it. It does not start a core or assert traffic flow.
func TestNativeTemplateFollowedProfileUpdate(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			env := "ROUTEWEAVER_MIHOMO_BIN"
			versionArgs := []string{"-v"}
			if target.AdapterID == "sing-box" {
				env = "ROUTEWEAVER_SINGBOX_BIN"
				versionArgs = []string{"version"}
			}
			binary := os.Getenv(env)
			if binary == "" {
				t.Skip("native validator not requested: " + env + " is unset")
			}
			version, e := exec.Command(binary, versionArgs...).CombinedOutput()
			if e != nil || !strings.Contains(string(version), target.Version) {
				t.Fatalf("native version mismatch: %s %v", version, e)
			}
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "native-template-user")
			status, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("profile", target))
			if status != 200 {
				t.Fatal(raw)
			}
			// Another profile must not be changed when this reference is advanced.
			status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("unrelated", target))
			if status != 200 {
				t.Fatal(raw)
			}
			status, _, unrelatedBefore := req(t, u.c, "GET", srv.URL+"/api/me/profiles/unrelated/reveal", "", nil)
			if status != 200 {
				t.Fatal(unrelatedBefore)
			}
			spec := baseProfileSpec()
			status, _, raw = adminTemplateRequest(t, srv, profileTemplate(0, spec))
			if status != 201 {
				t.Fatal(raw)
			}
			status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/templates/profile-library/select", u.csrf, map[string]any{"mode": "follow", "targetId": "profile", "version": 1})
			if status != 200 {
				t.Fatal(raw)
			}
			spec.Rules = []domain.PolicyRule{{ID: "native-rule", Match: domain.MatchExpression{Op: "domain-suffix", Value: "native.example"}, Action: domain.ActionRef{Kind: "reject"}}}
			spec.Runtime.Sniff = true
			status, _, raw = adminTemplateRequest(t, srv, profileTemplate(1, spec))
			if status != 201 {
				t.Fatal(raw)
			}
			status, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/preview", u.csrf, map[string]any{})
			if status != 200 || preview["compatible"] != true || preview["nativeChecked"] != false {
				t.Fatalf("preview: %d %s", status, raw)
			}
			status, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/template-bindings/profiles_profile/apply", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
			if status != 200 {
				t.Fatal(raw)
			}
			status, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/profile/reveal", "", nil)
			if status != 200 {
				t.Fatal(raw)
			}
			var p httpapi.Profile
			if e = json.Unmarshal([]byte(raw), &p); e != nil {
				t.Fatal(e)
			}
			rendered, e := render.DefaultClients().Render(p.IR, p.Target, p.Mode)
			if e != nil {
				t.Fatal(e)
			}
			dir := t.TempDir()
			configPath := filepath.Join(dir, rendered.Artifacts[0].Path)
			if e = os.WriteFile(configPath, []byte(rendered.Artifacts[0].Content), 0600); e != nil {
				t.Fatal(e)
			}
			args := []string{"-t", "-d", dir, "-f", configPath}
			if target.AdapterID == "sing-box" {
				args = []string{"check", "-c", configPath}
			}
			cmd := exec.Command(binary, args...)
			cmd.Dir = dir
			if output, e := cmd.CombinedOutput(); e != nil {
				t.Fatalf("followed candidate native check failed: %v\n%s", e, output)
			}
			status, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-output", "name": "Validated subscription", "profileId": "profile"})
			if status != 201 {
				t.Fatal(raw)
			}
			status, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if status != 200 || feed != rendered.Artifacts[0].Content {
				t.Fatal("published bytes differ from native-validated candidate")
			}
			status, _, unrelatedAfter := req(t, u.c, "GET", srv.URL+"/api/me/profiles/unrelated/reveal", "", nil)
			if status != 200 || unrelatedAfter != unrelatedBefore {
				t.Fatal("template update changed unrelated profile")
			}
			t.Logf("%s %s: library selection, followed preview, draft apply, native parser check and publication passed", target.AdapterID, target.Version)
		})
	}
}
