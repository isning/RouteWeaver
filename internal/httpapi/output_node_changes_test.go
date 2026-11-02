package httpapi_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNodesOnlyReviewComparesFrozenExportedSettings(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "node-review")
	p := templateTestProfile("node-review", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.Mode = render.NodesOnly
	check := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, v, _ := req(t, u.c, method, srv.URL+"/api"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s got %d", method, path, code)
		}
		return v
	}
	check("POST", "/me/profiles", p, 200)
	check("POST", "/me/outputs", map[string]any{"id": "review", "name": "Review", "profileId": p.ID}, 201)
	p.IR.Endpoints[0].Connection.Port++
	saveCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+p.ID, p)
	preview := check("POST", "/me/profiles/"+p.ID+"/preview", map[string]any{"outputId": "review"}, 200)
	changes, ok := preview["nodeChanges"].(map[string]any)
	if !ok {
		t.Fatal("selected nodes-only review must compare frozen exported nodes")
	}
	if changes["state"] != "available" || changes["affectedNodeCount"] != float64(1) {
		t.Fatalf("wrong available node change summary: %v", changes)
	}
	rows := changes["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["settingsChanged"] != true {
		t.Fatal("same stable endpoint must identify exported settings change")
	}
}

func TestNodesOnlyReviewIdentityPrivacyCountsAndOrder(t *testing.T) {
	for _, scenario := range []string{"rename-settings", "add-remove", "order", "limit", "same-export", "legacy", "malformed", "cross-owner"} {
		t.Run(scenario, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "nodes-"+scenario)
			p := templateTestProfile("nodes", render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion})
			p.Mode = render.NodesOnly
			p.IR.Endpoints[0].Name = "Alpha"
			second := p.IR.Endpoints[0]
			second.ID = "second"
			second.Name = "Beta"
			p.IR.Endpoints = append(p.IR.Endpoints, second)
			if scenario == "rename-settings" {
				p.IR.Endpoints[0].Name = "secret-password"
			}
			if scenario == "same-export" {
				p.IR.Endpoints[0].Connection = domain.Connection{Protocol: "vless", Host: "alpha.example", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, Fingerprint: "chrome"}}
			}
			if scenario == "limit" {
				p.IR.Endpoints = nil
				for i := 0; i < 60; i++ {
					n := second
					n.ID = fmt.Sprintf("node-%d", i)
					n.Name = fmt.Sprintf("Node %d", i)
					p.IR.Endpoints = append(p.IR.Endpoints, n)
				}
			}
			call := func(method, path string, body any, want int) map[string]any {
				t.Helper()
				code, v, _ := req(t, u.c, method, srv.URL+"/api"+path, u.csrf, body)
				if code != want {
					t.Fatalf("%s %s: %d", method, path, code)
				}
				return v
			}
			call("POST", "/me/profiles", p, 200)
			created := call("POST", "/me/outputs", map[string]any{"id": "main", "name": "Main", "profileId": p.ID}, 201)
			for _, key := range []string{"nodeChanges", "nameAllocations", "settings", "secrets"} {
				if _, ok := created[key]; ok {
					t.Fatal("private comparison escaped creation view")
				}
			}
			switch scenario {
			case "rename-settings":
				p.IR.Endpoints[0].Name = "rotated-private"
				p.IR.Endpoints[0].Connection.Password = "rotated-private"
			case "add-remove":
				p.IR.Endpoints = p.IR.Endpoints[:1]
				n := second
				n.ID = "third"
				n.Name = "Gamma"
				p.IR.Endpoints = append(p.IR.Endpoints, n)
			case "order":
				p.IR.Endpoints[0], p.IR.Endpoints[1] = p.IR.Endpoints[1], p.IR.Endpoints[0]
			case "limit":
				for i := range p.IR.Endpoints {
					p.IR.Endpoints[i].Connection.Password = "rotated-private"
				}
			case "same-export":
				p.IR.Endpoints[0].Connection.TLS.Fingerprint = "Chrome"
				p.IR.Endpoints[0].Connection.Transport = &domain.TransportOptions{Type: "tcp"}
			case "legacy", "malformed":
				var old httpapi.Output
				if e := s.TenantGet(u.id, "outputs", "main", &old); e != nil {
					t.Fatal(e)
				}
				if scenario == "legacy" {
					old.NameAllocations = nil
				} else {
					old.Artifacts[0].Content = `{"outbounds":null}`
				}
				if e := s.TenantPut(u.id, "outputs", "main", old); e != nil {
					t.Fatal(e)
				}
			case "cross-owner":
				other := inviteClient(t, s, srv, "nodes-other")
				code, _, _ := req(t, other.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", other.csrf, map[string]any{"outputId": "main"})
				if code != 404 {
					t.Fatalf("cross-owner preview got%d", code)
				}
				return
			}
			saveCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+p.ID, p)
			preview := call("POST", "/me/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
			d := preview["nodeChanges"].(map[string]any)
			if scenario == "legacy" || scenario == "malformed" {
				if d["state"] != "unavailable" || d["affectedNodeCount"] != nil {
					t.Fatal("missing historical evidence became zero")
				}
				return
			}
			if d["state"] != "available" {
				t.Fatal("comparison unavailable")
			}
			rows := d["rows"].([]any)
			switch scenario {
			case "rename-settings":
				if d["affectedNodeCount"] != float64(1) || d["modifiedCount"] != float64(1) || len(rows) != 1 {
					t.Fatal("combined update double counted")
				}
				r := rows[0].(map[string]any)
				if r["nameChanged"] != true || r["settingsChanged"] != true {
					t.Fatal("missing separate flags")
				}
				encoded, _ := json.Marshal(d)
				for _, secret := range []string{"secret-password", "rotated-private", "private-user"} {
					if strings.Contains(string(encoded), secret) {
						t.Fatal("known secret leaked in node label")
					}
				}
			case "add-remove":
				if d["addedCount"] != float64(1) || d["removedCount"] != float64(1) || d["affectedNodeCount"] != float64(2) || d["orderChanged"] != false {
					t.Fatal("wrong membership/order comparison")
				}
			case "order":
				if d["affectedNodeCount"] != float64(0) || d["orderChanged"] != true {
					t.Fatal("reorder inflated node count")
				}
			case "limit":
				if len(rows) != 50 || d["omittedRowCount"] != float64(10) || d["affectedNodeCount"] != float64(60) {
					t.Fatal("truncated totals")
				}
			case "same-export":
				if d["affectedNodeCount"] != float64(0) {
					t.Fatal("raw input difference misreported as exported settings")
				}
				cmp := call("GET", "/me/outputs/main/comparison", nil, 200)
				if cmp["draftComparison"].(map[string]any)["state"] != "unchanged" {
					t.Fatal("comparison changed despite identical emitted content")
				}
			}
			// Same snapshot still requires explicit publication; no comparison data leaks
			// through ordinary detail/access/comparison endpoints.
			for _, path := range []string{"/me/outputs/main/status", "/me/outputs/main/access", "/me/outputs/main/comparison"} {
				v := call("GET", path, nil, 200)
				if v["nodeChanges"] != nil {
					t.Fatal("node detail leaked into another DTO")
				}
			}
		})
	}
}

func TestNodesOnlyReviewTenThousandMeasured(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "nodes-scale")
	var content strings.Builder
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(&content, "socks5://user:synthetic-%05d@node-%05d.example:1080#Node-%05d\n", i, i, i)
	}
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, v, _ := req(t, u.c, method, srv.URL+"/api"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s got%d", method, path, code)
		}
		return v
	}
	call("POST", "/me/sources", map[string]any{"id": "scale", "name": "Scale", "applyMode": "manual", "kind": "text", "format": "uri-list", "enabled": true, "content": content.String()}, 200)
	p := templateTestProfile("scale", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.Mode = render.NodesOnly
	p.SourceIDs = []string{"scale"}
	p.IR.Endpoints = nil
	call("POST", "/me/profiles", p, 200)
	created := call("POST", "/me/outputs", map[string]any{"id": "scale", "name": "Scale", "profileId": "scale"}, 201)
	_, _, artifact := req(t, u.c, "GET", srv.URL+created["feedPath"].(string), "", nil)
	t.Logf("FROZEN_ARTIFACT bytes=%d sha256=%x", len(artifact), sha256.Sum256([]byte(artifact)))
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	v := call("POST", "/me/profiles/scale/preview", map[string]any{"outputId": "scale"}, 200)
	elapsed := time.Since(start)
	runtime.ReadMemStats(&after)
	d := v["nodeChanges"].(map[string]any)
	if d["state"] != "available" || d["beforeCount"] != float64(10000) || d["afterCount"] != float64(10000) || d["affectedNodeCount"] != float64(0) {
		t.Fatal("supported10K comparison unavailable/incorrect")
	}
	t.Logf("TEN_THOUSAND owner HTTP preview: elapsed=%s allocated_bytes=%d heap_after_bytes=%d (allocation, not isolated peak)", elapsed, after.TotalAlloc-before.TotalAlloc, after.HeapAlloc)
	updated := call("PUT", "/me/sources/scale", map[string]any{"id": "scale", "name": "Scale", "applyMode": "manual", "kind": "text", "format": "uri-list", "enabled": true, "content": strings.ReplaceAll(content.String(), "synthetic-", "rotated-")}, 200)
	candidate := updated["candidate"].(map[string]any)
	call("POST", "/me/sources/scale/candidate/accept", map[string]any{"candidateId": candidate["id"], "sourceRevision": updated["revision"]}, 200)
	runtime.GC()
	runtime.ReadMemStats(&before)
	start = time.Now()
	v = call("POST", "/me/profiles/scale/preview", map[string]any{"outputId": "scale"}, 200)
	elapsed = time.Since(start)
	runtime.ReadMemStats(&after)
	changed := v["nodeChanges"].(map[string]any)
	if changed["state"] != "available" || changed["affectedNodeCount"] != float64(10000) {
		t.Fatal("changed10K unavailable/incorrect")
	}
	t.Logf("TEN_THOUSAND_CHANGED owner HTTP preview: elapsed=%s allocated_bytes=%d heap_after_bytes=%d", elapsed, after.TotalAlloc-before.TotalAlloc, after.HeapAlloc)
	metadata, _ := json.Marshal(v["nodeChanges"])
	t.Logf("NODE_DTO_BYTES %d", len(metadata))

}
func TestNodesOnlyReviewTwoNodesMeasured(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "nodes-scale")
	var content strings.Builder
	for i := 0; i < 2; i++ {
		fmt.Fprintf(&content, "socks5://user:synthetic-%05d@node-%05d.example:1080#Node-%05d\n", i, i, i)
	}
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, v, _ := req(t, u.c, method, srv.URL+"/api"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s got%d", method, path, code)
		}
		return v
	}
	call("POST", "/me/sources", map[string]any{"id": "scale", "name": "Scale", "applyMode": "manual", "kind": "text", "format": "uri-list", "enabled": true, "content": content.String()}, 200)
	p := templateTestProfile("scale", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.Mode = render.NodesOnly
	p.SourceIDs = []string{"scale"}
	p.IR.Endpoints = nil
	call("POST", "/me/profiles", p, 200)
	created := call("POST", "/me/outputs", map[string]any{"id": "scale", "name": "Scale", "profileId": "scale"}, 201)
	_, _, artifact := req(t, u.c, "GET", srv.URL+created["feedPath"].(string), "", nil)
	t.Logf("FROZEN_ARTIFACT bytes=%d sha256=%x", len(artifact), sha256.Sum256([]byte(artifact)))
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	v := call("POST", "/me/profiles/scale/preview", map[string]any{"outputId": "scale"}, 200)
	elapsed := time.Since(start)
	runtime.ReadMemStats(&after)
	d := v["nodeChanges"].(map[string]any)
	if d["state"] != "available" || d["beforeCount"] != float64(2) || d["afterCount"] != float64(2) || d["affectedNodeCount"] != float64(0) {
		t.Fatal("supported10K comparison unavailable/incorrect")
	}
	t.Logf("TWO_NODES owner HTTP preview: elapsed=%s allocated_bytes=%d heap_after_bytes=%d (allocation, not isolated peak)", elapsed, after.TotalAlloc-before.TotalAlloc, after.HeapAlloc)
	updated := call("PUT", "/me/sources/scale", map[string]any{"id": "scale", "name": "Scale", "applyMode": "manual", "kind": "text", "format": "uri-list", "enabled": true, "content": strings.ReplaceAll(content.String(), "synthetic-", "rotated-")}, 200)
	candidate := updated["candidate"].(map[string]any)
	call("POST", "/me/sources/scale/candidate/accept", map[string]any{"candidateId": candidate["id"], "sourceRevision": updated["revision"]}, 200)
	runtime.GC()
	runtime.ReadMemStats(&before)
	start = time.Now()
	v = call("POST", "/me/profiles/scale/preview", map[string]any{"outputId": "scale"}, 200)
	elapsed = time.Since(start)
	runtime.ReadMemStats(&after)
	changed := v["nodeChanges"].(map[string]any)
	if changed["state"] != "available" || changed["affectedNodeCount"] != float64(2) {
		t.Fatal("changed10K unavailable/incorrect")
	}
	t.Logf("TWO_NODES_CHANGED owner HTTP preview: elapsed=%s allocated_bytes=%d heap_after_bytes=%d", elapsed, after.TotalAlloc-before.TotalAlloc, after.HeapAlloc)
	metadata, _ := json.Marshal(v["nodeChanges"])
	t.Logf("NODE_DTO_BYTES %d", len(metadata))

}

func TestNodesOnlyInspectionCeilingDoesNotReducePublicationCapacity(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "nodes-ceiling")
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, v, _ := req(t, u.c, method, srv.URL+"/api"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s got%d", method, path, code)
		}
		return v
	}
	var text strings.Builder
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(&text, "socks5://node-%d.example:1080#Node-%d\n", i, i)
	}
	for id, content := range map[string]string{"many": text.String(), "extra": "socks5://extra.example:1080#Extra"} {
		call("POST", "/me/sources", map[string]any{"id": id, "name": id, "kind": "text", "enabled": true, "content": content}, 200)
	}
	p := templateTestProfile("ceiling", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.Mode = render.NodesOnly
	p.SourceIDs = []string{"many", "extra"}
	p.IR.Endpoints = nil
	call("POST", "/me/profiles", p, 200)
	call("POST", "/me/outputs", map[string]any{"id": "ceiling", "name": "Ceiling", "profileId": p.ID}, 201)
	review := call("POST", "/me/profiles/ceiling/preview", map[string]any{"outputId": "ceiling"}, 200)
	d := review["nodeChanges"].(map[string]any)
	if d["state"] != "unavailable" || d["beforeCount"] != nil || d["affectedNodeCount"] != nil {
		t.Fatal("inspection limit must not fabricate empty detail")
	}
	call("POST", "/me/outputs/ceiling/publish", map[string]any{"previewDigest": review["previewDigest"]}, 200)
}
