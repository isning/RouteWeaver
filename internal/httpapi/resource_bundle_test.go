package httpapi_test

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestOwnedRuleFilesPublishAsExactFrozenBundle(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "rule-owner")
	b := inviteClient(t, s, srv, "rule-other")
	body := "payload:\n  - '+.private-rule.example'\n"
	request := map[string]any{"resource": map[string]any{"id": "private-rules", "name": "Private rules", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "pinned"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(body))}
	code, accepted, raw := req(t, a.c, "POST", srv.URL+"/api/me/resources/import", a.csrf, request)
	if code != 201 {
		t.Fatalf("accept owned file: %d %s", code, raw)
	}
	if accepted["acceptedVersion"] == "" || accepted["digest"] == "" || strings.Contains(raw, "private-rule.example") {
		t.Fatalf("accept metadata only: %s", raw)
	}
	code, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/resources/private-rules", "", nil)
	if code != 404 {
		t.Fatalf("cross-owner metadata: %d %s", code, raw)
	}
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
	p.IR.Resources = []domain.RuleResource{{ID: "private-rules"}}
	p.IR.Rules = []domain.PolicyRule{{ID: "file-rule", Match: domain.MatchExpression{Op: "resource", Value: "private-rules"}, Action: domain.ActionRef{Kind: "reject"}}}
	code, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, p)
	if code != 200 {
		t.Fatalf("save profile: %d %s", code, raw)
	}
	code, preview, raw := req(t, a.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", a.csrf, map[string]any{})
	if code != 200 || strings.Contains(raw, "private-rule.example") || preview["valid"] != true {
		t.Fatalf("safe preview: %d %s", code, raw)
	}
	code, out, raw := req(t, a.c, "POST", srv.URL+"/api/me/outputs", a.csrf, map[string]any{"id": "private-output", "name": "Private output", "profileId": p.ID})
	if code != 201 || out["delivery"] != "bundle" {
		t.Fatalf("publish bundle: %d %s", code, raw)
	}
	path := out["downloadPath"].(string)
	code, _, raw = req(t, b.c, "GET", srv.URL+path, "", nil)
	if code != 404 {
		t.Fatalf("cross-owner bundle: %d", code)
	}
	files := downloadBundle(t, a.c, srv.URL+path)
	if len(files) != 3 || string(files[accepted["path"].(string)]) != body {
		t.Fatalf("bundle bytes: %v", files)
	}
	config := string(files["mihomo.json"])
	if !strings.Contains(config, accepted["path"].(string)) || strings.Contains(config, "private-rule.example") {
		t.Fatalf("not a separate file: %s", config)
	}
	// A later accepted version must not mutate an already published output.
	request["contentBase64"] = base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.next.example'\n"))
	code, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/resources/import", a.csrf, request)
	if code != 201 {
		t.Fatal(raw)
	}
	files = downloadBundle(t, a.c, srv.URL+path)
	if string(files[accepted["path"].(string)]) != body {
		t.Fatal("published file changed under pin")
	}
}

func downloadBundle(t *testing.T, c *http.Client, url string) map[string][]byte {
	t.Helper()
	r, e := c.Get(url)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	data, e := io.ReadAll(r.Body)
	if e != nil {
		t.Fatal(e)
	}
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("bundle: %d %s", r.StatusCode, data)
	}
	z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		t.Fatal(e)
	}
	out := map[string][]byte{}
	for _, f := range z.File {
		rc, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		out[f.Name], e = io.ReadAll(rc)
		rc.Close()
		if e != nil {
			t.Fatal(e)
		}
	}
	return out
}

func TestRuleFileImportRejectsUnownedPathsAndMismatchedPins(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "file-security")
	b := inviteClient(t, s, srv, "file-foreign")
	body := "payload:\n  - '+.owned.example'\n"
	for _, tc := range []struct {
		name   string
		extra  map[string]any
		csrf   string
		status int
	}{
		{"csrf", nil, "", 403},
		{"owner", map[string]any{"ownerId": b.id}, a.csrf, 403},
		{"path", map[string]any{"path": "../../etc/passwd"}, a.csrf, 400},
		{"absolute path", map[string]any{"path": "/etc/passwd"}, a.csrf, 400},
		{"forged version", map[string]any{"acceptedVersion": strings.Repeat("0", 64)}, a.csrf, 400},
		{"wrong digest", map[string]any{"digest": "sha256:" + strings.Repeat("0", 64)}, a.csrf, 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := map[string]any{"id": "owned", "name": "Owned", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "pinned"}
			for k, v := range tc.extra {
				r[k] = v
			}
			code, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/resources/import", tc.csrf, map[string]any{"resource": r, "contentBase64": base64.StdEncoding.EncodeToString([]byte(body))})
			if code != tc.status {
				t.Fatalf("%d %s", code, raw)
			}
		})
	}
	// Public visibility and an arbitrary relative Path do not grant delivery.
	resource := domain.RuleResource{ID: "forged", Visibility: "public", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-yaml", Behavior: "domain", Location: "local", Path: "rules/arbitrary.yaml", UpdatePolicy: "pinned"}
	code, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/resources", a.csrf, resource)
	if code != 422 {
		t.Fatalf("forged local resource accepted: %d %s", code, raw)
	}
}

func TestFrozenBundleTokenRotationRevocationAndStaleReview(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "bundle-review")
	request := map[string]any{"resource": map[string]any{"id": "rules", "format": "sing-box-source", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(`{"version":5,"rules":[{"domain_suffix":["old.example"]}]}`))}
	code, accepted, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, request)
	if code != 201 {
		t.Fatal(raw)
	}
	p := nativeProfile(render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, `{}`)
	p.IR.Resources = []domain.RuleResource{{ID: "rules"}}
	p.IR.Rules = []domain.PolicyRule{{ID: "file", Match: domain.MatchExpression{Op: "resource", Value: "rules"}, Action: domain.ActionRef{Kind: "reject"}}}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "review", "name": "Review", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	oldPath := out["bundlePath"].(string)
	before := downloadBundle(t, http.DefaultClient, srv.URL+oldPath)
	code, _, raw = req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 409 {
		t.Fatalf("broken bare config delivered: %d", code)
	}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "review"})
	if code != 200 {
		t.Fatal(raw)
	}
	request["contentBase64"] = base64.StdEncoding.EncodeToString([]byte(`{"version":5,"rules":[{"domain_suffix":["new.example"]}]}`))
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, request)
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/review/publish", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
	if code != 409 {
		t.Fatalf("stale file review accepted: %d %s", code, raw)
	}
	after := downloadBundle(t, http.DefaultClient, srv.URL+oldPath)
	if !bytes.Equal(before[accepted["path"].(string)], after[accepted["path"].(string)]) {
		t.Fatal("stale publication changed accepted file")
	}
	code, rotated, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/review/rotate", u.csrf, map[string]any{})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, http.DefaultClient, "GET", srv.URL+oldPath, "", nil)
	if code != 404 {
		t.Fatalf("old bundle token still works: %d", code)
	}
	downloadBundle(t, http.DefaultClient, srv.URL+rotated["bundlePath"].(string))
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/review/revoke", u.csrf, map[string]any{})
	if code != 200 {
		t.Fatal(raw)
	}
	for _, path := range []string{rotated["bundlePath"].(string), out["downloadPath"].(string)} {
		code, _, raw = req(t, u.c, "GET", srv.URL+path, "", nil)
		if code != 404 {
			t.Fatalf("revoked bundle: %d %s", code, raw)
		}
	}
}

func TestRuleRefreshFailureRetainsAcceptedBytesWithoutPretendingFreshness(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "rule-refresh")
	original := `{"version":5,"rules":[{"domain":["accepted.example"]}]}`
	code, accepted, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, map[string]any{"resource": map[string]any{"id": "remote-file", "format": "sing-box-source", "updatePolicy": "pinned"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(original))})
	if code != 201 {
		t.Fatal(raw)
	}
	// Stored provenance is a private remote source; its next explicit fetch is
	// rejected by the real SSRF policy before any network connection.
	var record map[string]any
	if err := s.TenantGet(u.id, "resources", "remote-file", &record); err != nil {
		t.Fatal(err)
	}
	record["sourceUrl"] = "https://127.0.0.1/private?token=not-for-preview"
	if err := s.TenantPut(u.id, "resources", "remote-file", record); err != nil {
		t.Fatal(err)
	}
	p := nativeProfile(render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, `{}`)
	p.IR.Resources = []domain.RuleResource{{ID: "remote-file"}}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "remote-output", "name": "Remote output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	// Publication and export use accepted bytes and perform no implicit fetch.
	files := downloadBundle(t, u.c, srv.URL+out["downloadPath"].(string))
	if string(files[accepted["path"].(string)]) != original {
		t.Fatal("accepted file differs")
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources/remote-file/refresh", u.csrf, map[string]any{})
	if code != 422 || strings.Contains(raw, "not-for-preview") {
		t.Fatalf("refresh failure: %d %s", code, raw)
	}
	code, metadata, raw := req(t, u.c, "GET", srv.URL+"/api/me/resources/remote-file", "", nil)
	if code != 200 || metadata["digest"] != accepted["digest"] || metadata["refreshStatus"] != "failed" || metadata["canRefresh"] != true || strings.Contains(raw, "not-for-preview") || strings.Contains(raw, "127.0.0.1") || strings.Contains(raw, "accepted.example") {
		t.Fatalf("private stale metadata: %d %s", code, raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/remote-output/publish", u.csrf, map[string]any{})
	if code != 422 {
		t.Fatalf("failed refresh incorrectly publishable: %d %s", code, raw)
	}
	files = downloadBundle(t, u.c, srv.URL+out["downloadPath"].(string))
	if string(files[accepted["path"].(string)]) != original {
		t.Fatal("failed refresh overwrote frozen file")
	}
}

func TestRuleBundleRejectsTamperedFileAndForeignAcceptedVersion(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "file-tamper")
	b := inviteClient(t, s, srv, "file-foreign-version")
	body := `{"version":5,"rules":[]}`
	code, accepted, raw := req(t, a.c, "POST", srv.URL+"/api/me/resources/import", a.csrf, map[string]any{"resource": map[string]any{"id": "protected", "format": "sing-box-source", "updatePolicy": "pinned"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(body))})
	if code != 201 {
		t.Fatal(raw)
	}
	p := nativeProfile(render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, `{}`)
	p.IR.Resources = []domain.RuleResource{{ID: "protected", AcceptedVersion: accepted["acceptedVersion"].(string), UpdatePolicy: "pinned"}}
	code, _, raw = req(t, b.c, "POST", srv.URL+"/api/me/profiles", b.csrf, p)
	if code < 400 {
		t.Fatal("foreign accepted version authorized")
	}
	code, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, a.c, "POST", srv.URL+"/api/me/outputs", a.csrf, map[string]any{"id": "tamper-output", "name": "Tamper output", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	var output httpapi.Output
	if err := s.TenantGet(a.id, "outputs", "tamper-output", &output); err != nil {
		t.Fatal(err)
	}
	output.ResourceFiles[0].Body = []byte(`{"version":5,"rules":[{"domain":["tampered.example"]}]}`)
	if err := s.TenantPut(a.id, "outputs", "tamper-output", output); err != nil {
		t.Fatal(err)
	}
	code, _, raw = req(t, a.c, "GET", srv.URL+out["downloadPath"].(string), "", nil)
	if code != 422 || strings.Contains(raw, "tampered.example") {
		t.Fatalf("tampered bytes delivered: %d %s", code, raw)
	}
}
