package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestOutputReviewRejectsChangedProfileAndPreservesFeed(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "output-review")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"tcp-concurrent":true}`)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "reviewed", "name": "Reviewed", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, _, before := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatal(before)
	}
	code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
	if code != 200 {
		t.Fatal(raw)
	}
	digest, ok := preview["previewDigest"].(string)
	if !ok || len(digest) != 64 {
		t.Fatal("output review must include exact-input digest")
	}
	p.IR.NativeOverride.Content = `{"tcp-concurrent":false}`
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": digest})
	if code != 409 {
		t.Fatalf("changed profile published after review: %d %s", code, raw)
	}
	code, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || before != after {
		t.Fatal("stale review changed existing feed")
	}
	code, current, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
	if code != 200 || current["previewDigest"] == digest {
		t.Fatalf("changed profile did not change review: %d %s", code, raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": current["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, after = req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 || after == before || !strings.Contains(after, `"tcp-concurrent": false`) {
		t.Fatal("fresh reviewed update not published")
	}
}

func TestOutputReviewFencesSourceAndOutputChanges(t *testing.T) {
	for _, change := range []string{"source", "output"} {
		t.Run(change, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "output-source-review")
			source := map[string]any{"id": "source", "name": "Private source", "kind": "text", "format": "uri-list", "content": "socks5://192.0.2.10:1080#Original", "enabled": true}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
			if code != 200 {
				t.Fatal(raw)
			}
			p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
			p.SourceIDs = []string{"source"}
			p.IR.Endpoints = nil
			p.IR.Groups = nil
			p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "reviewed", "name": "Reviewed", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			code, _, before := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 {
				t.Fatal(before)
			}
			code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
			if code != 200 {
				t.Fatal(raw)
			}
			digest, ok := preview["previewDigest"].(string)
			if !ok || len(digest) != 64 {
				t.Fatal("missing output digest")
			}
			// An identical repeat must be stable, despite wall-clock time.
			code, again, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
			if code != 200 || again["previewDigest"] != digest {
				t.Fatal("unchanged review digest is unstable")
			}
			if change == "source" {
				source["content"] = "socks5://192.0.2.20:1080#Changed"
				code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/sources/source", u.csrf, source)
			} else {
				// A parallel latest-draft publication changes output revision even if the
				// final bytes stay the same; its new allocation/token state cannot be lost.
				code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{})
			}
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": digest})
			if code != 409 {
				t.Fatalf("stale %s review accepted: %d %s", change, code, raw)
			}
			code, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 || before != after {
				t.Fatalf("stale %s review replaced feed", change)
			}
			code, current, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
			if code != 200 || current["previewDigest"] == digest {
				t.Fatal("input change did not change digest")
			}
			for _, bad := range []string{"", strings.Repeat("0", 64)} {
				code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": bad})
				if code != 409 {
					t.Fatalf("invalid digest accepted: %d %s", code, raw)
				}
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": current["previewDigest"]})
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, after = req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			want := current["artifacts"].([]any)[0].(map[string]any)["content"].(string)
			if code != 200 || strings.TrimSuffix(after, "\n") != want {
				t.Fatal("published bytes differ from fresh no-secret review")
			}
		})
	}
}

func TestOutputReviewFencesOwnedResourceAndGrantInputs(t *testing.T) {
	for _, kind := range []string{"resource", "grant"} {
		t.Run(kind, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "dependency-review")
			p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
			resource := domain.RuleResource{ID: "work", Visibility: "public", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-yaml", Behavior: "domain", Location: "remote", URL: "https://rules.example/work.yaml", UpdatePolicy: "follow", IntervalSeconds: 3600}
			grant := httpapi.PublicEntryGrant{ID: "entry", Name: "Original entry", RouteID: "route", CredentialVersion: "v1", Connection: domain.Connection{Host: "192.0.2.10", Port: 1080, Protocol: "socks"}}
			var change func() (int, map[string]any, string)
			if kind == "resource" {
				code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources", u.csrf, resource)
				if code != 200 {
					t.Fatal(raw)
				}
				p.IR.Resources = []domain.RuleResource{resource}
				change = func() (int, map[string]any, string) {
					resource.Revision = "2"
					resource.Digest = "sha256:" + strings.Repeat("1", 64)
					return req(t, u.c, "PUT", srv.URL+"/api/me/resources/work", u.csrf, resource)
				}
			} else {
				if err := s.Put("routes", "route", domain.Route{ID: "route", Name: "Assigned route", UserIDs: []string{u.id}}); err != nil {
					t.Fatal(err)
				}
				path := srv.URL + "/api/users/" + u.id + "/entries"
				code, _, raw := req(t, operatorClient(), "POST", path, "", grant)
				if code != 201 {
					t.Fatal(raw)
				}
				p.PlatformEntryIDs = []string{"entry"}
				change = func() (int, map[string]any, string) {
					// Metadata-only change still invalidates exact input review. It does not
					// retire the credential or otherwise invalidate the previously served feed.
					grant.Name = "Updated entry"
					return req(t, operatorClient(), "POST", path, "", grant)
				}
			}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "reviewed", "name": "Reviewed", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			code, _, before := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 {
				t.Fatal(before)
			}
			code, preview, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "reviewed"})
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = change()
			if code != 200 && code != 201 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/reviewed/publish", u.csrf, map[string]any{"previewDigest": preview["previewDigest"]})
			if code != 409 {
				t.Fatalf("changed %s input accepted: %d %s", kind, code, raw)
			}
			code, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 || before != after {
				t.Fatal("failed reviewed publication changed feed")
			}
		})
	}
}

func TestOutputReviewBindsUnredactedNativeData(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-review")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"dns":{"enable":true,"nameserver":["https://dns.example/dns-query?key=synthetic-first"]}}`)
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "private", "name": "Private", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	code, before, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "private"})
	if code != 200 || strings.Contains(raw, "synthetic-first") {
		t.Fatal("review exposed private native URL data")
	}
	p.IR.NativeOverride.Content = strings.ReplaceAll(p.IR.NativeOverride.Content, "synthetic-first", "synthetic-second")
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, after, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "private"})
	if code != 200 || strings.Contains(raw, "synthetic-second") {
		t.Fatal("review exposed updated private native URL data")
	}
	if before["previewDigest"] == after["previewDigest"] {
		t.Fatal("secret-only input change did not invalidate exact review")
	}
	if before["artifacts"].([]any)[0].(map[string]any)["content"] != after["artifacts"].([]any)[0].(map[string]any)["content"] {
		t.Fatal("fixture must have identical redacted previews")
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/private/publish", u.csrf, map[string]any{"previewDigest": before["previewDigest"]})
	if code != 409 || strings.Contains(raw, "synthetic-") {
		t.Fatalf("private data change accepted or exposed: %d %s", code, raw)
	}
}
