package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/render"
)

// Uses only public HTTP operations. The retained owner DTO deliberately predates
// a revoke, just as an already-open browser list can. Never logs feed secrets.
func TestOutputReviewDescribesReplacementAfterRevokeBeforePreview(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "review-consequence")
	p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
	code, _, _ := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatalf("create profile: %d", code)
	}
	code, oldOutput, _ := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "consequence", "name": "Consequence", "profileId": p.ID})
	if code != 201 || oldOutput["status"] != "published" {
		t.Fatalf("create output: %d", code)
	}
	oldPath := oldOutput["feedPath"].(string)
	code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs/consequence/revoke", u.csrf, nil)
	if code != 200 {
		t.Fatalf("revoke: %d", code)
	}
	code, preview, _ := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": oldOutput["id"], "target": oldOutput["target"], "mode": oldOutput["mode"]})
	if code != 200 {
		t.Fatalf("preview: %d", code)
	}
	if preview["outputId"] != oldOutput["id"] || preview["previewScope"] != "output-update" {
		t.Fatal("review must identify selected output")
	}
	digest, ok := preview["previewDigest"].(string)
	if !ok || len(digest) != 64 {
		t.Fatal("missing bound review")
	}
	// Continue through publication before asserting the missing consequence, so a
	// RED proves the actual link outcome rather than merely an absent DTO field.
	code, published, _ := req(t, u.c, "POST", srv.URL+"/api/me/outputs/consequence/publish", u.csrf, map[string]any{"previewDigest": digest})
	if code != 200 || published["id"] != oldOutput["id"] {
		t.Fatalf("reviewed publication: %d", code)
	}
	code, access, _ := req(t, u.c, "GET", srv.URL+"/api/me/outputs/consequence/access", "", nil)
	if code != 200 {
		t.Fatalf("owner access: %d", code)
	}
	newPath, ok := access["feedPath"].(string)
	if !ok || newPath == oldPath {
		t.Fatal("revoked publication must issue replacement link")
	}
	code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+oldPath, "", nil)
	if code == 200 {
		t.Fatal("old feed must remain revoked")
	}
	code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+newPath, "", nil)
	if code != 200 {
		t.Fatalf("replacement feed: %d", code)
	}
	effect, ok := preview["publicationEffect"].(map[string]any)
	if !ok || effect["version"] != float64(1) || effect["link"] != "replace" {
		t.Fatal("approved preview did not disclose the replacement link actually issued")
	}
}

func TestOutputReviewConsequencePreservesLinkAndFencesLaterLifecycleChanges(t *testing.T) {
	for _, change := range []string{"none", "revoke", "rotate"} {
		t.Run(change, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "effect-"+change)
			p := nativeProfile(render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{}`)
			code, _, _ := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatalf("profile: %d", code)
			}
			outputs := make([]map[string]any, 0, 2)
			for _, id := range []string{"selected", "sibling"} {
				code, out, _ := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": id, "name": id, "profileId": p.ID})
				if code != 201 {
					t.Fatalf("output: %d", code)
				}
				outputs = append(outputs, out)
			}
			preview := func() map[string]any {
				t.Helper()
				code, value, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "selected"})
				if code != 200 {
					t.Fatalf("preview: %d", code)
				}
				if strings.Contains(raw, strings.TrimPrefix(outputs[0]["feedPath"].(string), "/feed/")) {
					t.Fatal("preview disclosed access secret")
				}
				effect, ok := value["publicationEffect"].(map[string]any)
				if !ok || effect["version"] != float64(1) || effect["link"] != "preserve" {
					t.Fatal("published token review must disclose preservation")
				}
				return value
			}
			first := preview()
			if preview()["previewDigest"] != first["previewDigest"] {
				t.Fatal("identical review must remain stable")
			}
			if change != "none" {
				code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs/selected/"+change, u.csrf, nil)
				if code != 200 {
					t.Fatalf("lifecycle mutation: %d", code)
				}
			}
			code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs/selected/publish", u.csrf, map[string]any{"previewDigest": first["previewDigest"]})
			want := 200
			if change != "none" {
				want = 409
			}
			if code != want {
				t.Fatalf("publication status = %d, want %d", code, want)
			}
			if change == "none" {
				code, access, _ := req(t, u.c, "GET", srv.URL+"/api/me/outputs/selected/access", "", nil)
				if code != 200 || access["feedPath"] != outputs[0]["feedPath"] {
					t.Fatal("approved preserve changed link")
				}
			}
			code, sibling, _ := req(t, u.c, "GET", srv.URL+"/api/me/outputs/sibling/access", "", nil)
			if code != 200 || sibling["feedPath"] != outputs[1]["feedPath"] {
				t.Fatal("selected review changed sibling access")
			}
			code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+outputs[1]["feedPath"].(string), "", nil)
			if code != 200 {
				t.Fatal("sibling feed unavailable")
			}
		})
	}
}
