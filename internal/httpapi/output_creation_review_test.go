package httpapi_test

import (
	"encoding/base64"
	"net/http"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestReviewedOutputCreationRejectsChangedProfile(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "create-review")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"tcp-concurrent":true}`)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	draft := map[string]any{"id": "new-output", "name": "Reviewed", "profileId": p.ID}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
	if code != 200 {
		t.Fatalf("preview new output: %d %s", code, raw)
	}
	digest, ok := preview["previewDigest"].(string)
	if !ok || len(digest) != 64 {
		t.Fatal("missing review digest")
	}
	p.IR.NativeOverride.Content = `{"tcp-concurrent":false}`
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	draft["previewDigest"] = digest
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
	if code != 409 {
		t.Fatalf("stale creation accepted: %d %s", code, raw)
	}
	code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || raw != "[]\n" {
		t.Fatalf("stale review published: %s", raw)
	}
	// The old API deliberately publishes current inputs when no review is supplied.
	delete(draft, "previewDigest")
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || !strings.Contains(raw, `"tcp-concurrent": false`) {
		t.Fatal(raw)
	}
	if out["creationReviewDigest"] != nil {
		t.Fatal("legacy creation claims a review receipt")
	}
}

func TestReviewedOutputCreationFencesInputsAndPublishesExactArtifact(t *testing.T) {
	for _, change := range []string{"source", "secret", "resource", "name", "id", "mode", "target", "owner"} {
		t.Run(change, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "create-inputs")
			source := map[string]any{"id": "source", "name": "Private source", "kind": "text", "format": "uri-list", "content": "socks5://192.0.2.10:1080#Original", "enabled": true}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
			if code != 200 {
				t.Fatal(raw)
			}
			p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
			if change == "mode" || change == "target" {
				p.IR.NativeOverride = nil
			}
			p.SourceIDs = []string{"source"}
			p.IR.Endpoints = nil
			p.IR.Groups = nil
			p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
			resource := domain.RuleResource{ID: "work", Visibility: "public", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-yaml", Behavior: "domain", Location: "remote", URL: "https://rules.example/work.yaml", UpdatePolicy: "follow", IntervalSeconds: 3600}
			if change == "resource" {
				code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources", u.csrf, resource)
				if code != 200 {
					t.Fatal(raw)
				}
				p.IR.Resources = []domain.RuleResource{resource}
			}
			if change == "secret" {
				p.IR.NativeOverride.Content = `{"dns":{"enable":true,"nameserver":["https://dns.example/dns-query?key=synthetic-first"]}}`
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			draft := map[string]any{"id": "new-output", "name": "Reviewed", "profileId": p.ID, "target": p.Target, "mode": "full"}
			code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
			if code != 200 || strings.Contains(raw, "synthetic-first") {
				t.Fatalf("preview: %d %s", code, raw)
			}
			code, again, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
			if code != 200 || again["previewDigest"] != preview["previewDigest"] {
				t.Fatalf("unstable preview: %s", raw)
			}
			switch change {
			case "source":
				source["content"] = "socks5://192.0.2.20:1080#Changed"
				code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/sources/source", u.csrf, source)
			case "secret":
				p.IR.NativeOverride.Content = strings.ReplaceAll(p.IR.NativeOverride.Content, "synthetic-first", "synthetic-second")
				code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
			case "resource":
				resource.Revision = "2"
				resource.Digest = "sha256:" + strings.Repeat("1", 64)
				code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/resources/work", u.csrf, resource)
			case "name":
				draft["name"] = "Different"
			case "id":
				draft["id"] = "different"
			case "mode":
				draft["mode"] = "nodes-only"
			case "target":
				draft["target"] = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
			case "owner":
				u = inviteClient(t, s, srv, "other-create-inputs")
				code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
				if code != 200 {
					t.Fatal(raw)
				}
				code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			}
			if code != 200 {
				t.Fatal(raw)
			}
			draft["previewDigest"] = preview["previewDigest"]
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
			if code != 409 || strings.Contains(raw, "synthetic-") {
				t.Fatalf("stale %s creation: %d %s", change, code, raw)
			}
			code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
			if code != 200 || raw != "[]\n" {
				t.Fatalf("rejected creation published: %s", raw)
			}
			delete(draft, "previewDigest")
			code, fresh, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
			if code != 200 || fresh["previewDigest"] == preview["previewDigest"] {
				t.Fatalf("review did not change: %d %s", code, raw)
			}
			if change == "secret" && fresh["artifacts"].([]any)[0].(map[string]any)["content"] != preview["artifacts"].([]any)[0].(map[string]any)["content"] {
				t.Fatal("secret-only fixture changed redacted bytes")
			}
			draft["previewDigest"] = fresh["previewDigest"]
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
			if code != 201 || out["creationReviewDigest"] != fresh["previewDigest"] {
				t.Fatalf("fresh creation: %d %s", code, raw)
			}
			code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			want := fresh["artifacts"].([]any)[0].(map[string]any)["content"].(string)
			if change == "secret" {
				if !strings.Contains(feed, "synthetic-second") || strings.Contains(feed, "synthetic-first") {
					t.Fatal("wrong secret materialized")
				}
			} else if code != 200 || strings.TrimSuffix(feed, "\n") != want {
				t.Fatal("published bytes differ from exact reviewed artifact")
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
			if code != 409 {
				t.Fatalf("duplicate creation: %d %s", code, raw)
			}
			code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
			if code != 200 || strings.Count(raw, `"id":`) != 1 || !strings.Contains(raw, fresh["previewDigest"].(string)) {
				t.Fatalf("lost-response receipt missing or duplicate: %s", raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/"+draft["id"].(string)+"/publish", u.csrf, map[string]any{})
			if code != 200 || strings.Contains(raw, "creationReviewDigest") {
				t.Fatalf("republish retained obsolete creation receipt: %s", raw)
			}
		})
	}
}

func TestReviewedOutputCreationFreezesPrivateBundleAndRejectsForgedReceipt(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "create-bundle")
	body := "payload:\n  - '+.reviewed-private.example'\n"
	upload := map[string]any{"resource": map[string]any{"id": "private-rules", "name": "Private rules", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(body))}
	code, accepted, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
	if code != 201 {
		t.Fatal(raw)
	}
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
	p.IR.Endpoints[0].Connection.Username = ""
	p.IR.Endpoints[0].Connection.Password = ""
	duplicate := p.IR.Endpoints[0]
	duplicate.ID = "second-node"
	duplicate.Connection.Host = "192.0.2.11"
	p.IR.Endpoints = append(p.IR.Endpoints, duplicate)
	p.IR.Resources = []domain.RuleResource{{ID: "private-rules"}}
	p.IR.Rules = []domain.PolicyRule{{ID: "file-rule", Match: domain.MatchExpression{Op: "resource", Value: "private-rules"}, Action: domain.ActionRef{Kind: "reject"}}}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	draft := map[string]any{"id": "bundle", "name": "Bundle", "profileId": p.ID}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
	if code != 200 || strings.Contains(raw, "reviewed-private.example") {
		t.Fatal(raw)
	}
	// Clients cannot assign the server's receipt or allocation map, including legacy callers.
	for _, field := range []string{"creationReviewDigest", "nameAllocations"} {
		draft[field] = "forged"
		code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
		if code != 400 {
			t.Fatalf("client-controlled %s: %d %s", field, code, raw)
		}
		delete(draft, field)
	}
	upload["contentBase64"] = base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.changed-private.example'\n"))
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
	if code != 201 {
		t.Fatal(raw)
	}
	draft["previewDigest"] = review["previewDigest"]
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
	if code != 409 {
		t.Fatalf("changed private file accepted: %d %s", code, raw)
	}
	delete(draft, "previewDigest")
	code, fresh, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, draft)
	if code != 200 {
		t.Fatal(raw)
	}
	draft["previewDigest"] = fresh["previewDigest"]
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, draft)
	if code != 201 || out["delivery"] != "bundle" {
		t.Fatalf("bundle creation: %d %s", code, raw)
	}
	code, outputReview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "bundle"})
	if code != 200 || !reflect.DeepEqual(outputReview["names"], fresh["names"]) {
		t.Fatal("creation did not retain reviewed stable names")
	}
	files := downloadBundle(t, u.c, srv.URL+out["downloadPath"].(string))
	artifact := fresh["artifacts"].([]any)[0].(map[string]any)
	if string(files[artifact["path"].(string)]) != artifact["content"].(string)+"\n" {
		t.Fatalf("bundle configuration differs from exact review: got %s want %s", files[artifact["path"].(string)], artifact["content"].(string))
	}
	found := false
	for name, data := range files {
		if strings.HasPrefix(name, "rules/") && string(data) == "payload:\n  - '+.changed-private.example'\n" {
			found = true
		}
	}
	if !found {
		t.Fatalf("reviewed rule file missing; original path was %s", accepted["path"])
	}
	// A third acceptance cannot mutate the published private bundle.
	upload["contentBase64"] = base64.StdEncoding.EncodeToString([]byte(body))
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
	if code != 201 {
		t.Fatal(raw)
	}
	later := downloadBundle(t, u.c, srv.URL+out["downloadPath"].(string))
	if !reflect.DeepEqual(files, later) {
		t.Fatal("published reviewed bundle changed")
	}
}
