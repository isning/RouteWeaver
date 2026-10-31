package httpapi_test

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// These fixtures exercise the actual owner upload, publication and ZIP download
// with real local files. A malformed-payload probe records whether that parser
// consumes the files or only validates their references. No external fetch
// or daemon/network startup is performed by this test.
func TestNativeOwnedRuleFileBundles(t *testing.T) {
	for _, format := range []string{"mihomo-yaml", "mrs", "sing-box-source", "srs"} {
		t.Run(format, func(t *testing.T) {
			target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
			env := "ROUTEWEAVER_MIHOMO_BIN"
			versionArgs := []string{"-v"}
			source := []byte("payload:\n  - '+.native-owned.example'\n")
			if format == "sing-box-source" || format == "srs" {
				target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
				env = "ROUTEWEAVER_SINGBOX_BIN"
				versionArgs = []string{"version"}
				source = []byte(`{"version":5,"rules":[{"domain_suffix":["native-owned.example"]}]}`)
			}
			binary := os.Getenv(env)
			if binary == "" {
				t.Skip("native bundle parser not requested: " + env + " is unset")
			}
			version, err := exec.Command(binary, versionArgs...).CombinedOutput()
			if err != nil || !strings.Contains(string(version), target.Version) {
				t.Fatalf("native version: %s %v", version, err)
			}
			body := source
			if format == "srs" || format == "mrs" {
				dir := t.TempDir()
				src := filepath.Join(dir, "source")
				dst := filepath.Join(dir, "compiled."+format)
				if err = os.WriteFile(src, source, 0600); err != nil {
					t.Fatal(err)
				}
				args := []string{"rule-set", "compile", "-o", dst, src}
				if format == "mrs" {
					args = []string{"convert-ruleset", "domain", "yaml", src, dst}
				}
				out, e := exec.Command(binary, args...).CombinedOutput()
				if e != nil {
					t.Fatalf("native file compile: %v %s", e, out)
				}
				body, err = os.ReadFile(dst)
				if err != nil {
					t.Fatal(err)
				}
			}
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "native-rule-file")
			resource := map[string]any{"id": "native-file", "format": format, "updatePolicy": "pinned"}
			if target.AdapterID == "mihomo" {
				resource["behavior"] = "domain"
			}
			code, accepted, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, map[string]any{"resource": resource, "contentBase64": base64.StdEncoding.EncodeToString(body)})
			if code != 201 {
				t.Fatalf("upload native file: %d %s", code, raw)
			}
			p := nativeProfile(target, `{}`)
			p.IR.Resources = []domain.RuleResource{{ID: "native-file"}}
			p.IR.Rules = []domain.PolicyRule{{ID: "file", Match: domain.MatchExpression{Op: "resource", Value: "native-file"}, Action: domain.ActionRef{Kind: "reject"}}}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-bundle", "name": "Native bundle", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			files := downloadBundle(t, u.c, srv.URL+out["downloadPath"].(string))
			if string(files[accepted["path"].(string)]) != string(body) {
				t.Fatal("native file bytes changed")
			}
			dir := t.TempDir()
			for name, data := range files {
				if name == "manifest.json" {
					continue
				}
				if filepath.IsAbs(name) || strings.Contains(name, "..") || strings.Contains(name, "\\") {
					t.Fatal("unsafe generated path")
				}
				path := filepath.Join(dir, name)
				if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			config := filepath.Join(dir, target.AdapterID+".json")
			args := []string{"-t", "-d", dir, "-f", config}
			if target.AdapterID == "sing-box" {
				args = []string{"check", "-c", config}
			}
			cmd := exec.Command(binary, args...)
			cmd.Dir = dir
			native, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("native bundle parser: %v\n%s", err, native)
			}
			t.Logf("%s %s accepted generated configuration referencing bundled %s", target.AdapterID, target.Version, format)
			if target.AdapterID == "mihomo" {
				rulePath := filepath.Join(dir, accepted["path"].(string))
				binaryRules := rulePath
				if format == "mihomo-yaml" {
					binaryRules = filepath.Join(dir, "native-validated.mrs")
					out, e := exec.Command(binary, "convert-ruleset", "domain", "yaml", rulePath, binaryRules).CombinedOutput()
					if e != nil {
						t.Fatalf("native parser rejected downloaded YAML: %v %s", e, out)
					}
				}
				decoded := filepath.Join(dir, "native-decoded.txt")
				out, e := exec.Command(binary, "convert-ruleset", "domain", "mrs", binaryRules, decoded).CombinedOutput()
				if e != nil {
					t.Fatalf("native parser rejected downloaded MRS: %v %s", e, out)
				}
				decodedBody, e := os.ReadFile(decoded)
				if e != nil || strings.TrimSpace(string(decodedBody)) != "+.native-owned.example" {
					t.Fatalf("native file parser did not consume fixture: %v %q", e, decodedBody)
				}
				t.Logf("Mihomo native converter separately parsed downloaded %s and recovered the expected domain", format)
			}
			// Sensitivity determines whether this core's check command actually
			// consumes provider payloads, rather than just config references.
			if err = os.WriteFile(filepath.Join(dir, accepted["path"].(string)), []byte("invalid-rule-file-payload"), 0600); err != nil {
				t.Fatal(err)
			}
			corrupt := exec.Command(binary, args...)
			corrupt.Dir = dir
			rejection, rejected := corrupt.CombinedOutput()
			if target.AdapterID == "sing-box" {
				if rejected == nil {
					t.Fatalf("sing-box check did not reject malformed %s payload", format)
				}
				t.Logf("sing-box check rejects malformed %s payload: %s", format, rejection)
			} else {
				if rejected == nil {
					t.Logf("Mihomo check alone does not reject malformed %s payload; it establishes only config/reference parsing", format)
				}
				inputFormat := "yaml"
				if format == "mrs" {
					inputFormat = "mrs"
				}
				_, fileErr := exec.Command(binary, "convert-ruleset", "domain", inputFormat, filepath.Join(dir, accepted["path"].(string)), filepath.Join(dir, "must-not-validate")).CombinedOutput()
				if fileErr == nil {
					t.Fatalf("Mihomo file parser did not reject malformed %s payload", format)
				}
				t.Logf("Mihomo native file converter rejects malformed %s payload", format)
			}
		})
	}
}
