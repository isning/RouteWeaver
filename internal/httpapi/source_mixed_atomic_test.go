package httpapi_test

import (
	"encoding/base64"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestMixedSourceImportNeverStoresPartialAcceptedSnapshot(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "mixed-import-owner")
	inputs := []struct{ name, format, content string }{
		{"uri unsupported", "uri-list", "socks5://new.example.test:1080#Valid\nunknown://synthetic-secret@bad.example.test:443"},
		{"uri malformed", "uri-list", "socks5://new.example.test:1080#Valid\nvless://not-a-uuid@bad.example.test:443#Invalid"},
		{"mihomo unsupported", "mihomo", `{"proxies":[{"name":"Valid","type":"socks5","server":"new.example.test","port":1080},{"name":"Invalid","type":"unknown","server":"bad.example.test","port":443}]}`},
		{"mihomo malformed", "mihomo", `{"proxies":[{"name":"Valid","type":"socks5","server":"new.example.test","port":1080},{"name":"Invalid","type":"socks5","server":"bad.example.test","port":70000}]}`},
		{"sing-box unsupported", "sing-box", `{"outbounds":[{"tag":"Valid","type":"socks","server":"new.example.test","server_port":1080},{"tag":"Invalid","type":"unknown","server":"bad.example.test","server_port":443}]}`},
		{"sing-box malformed", "sing-box", `{"outbounds":[{"tag":"Valid","type":"socks","server":"new.example.test","server_port":1080},{"tag":"Invalid","type":"socks","server":"bad.example.test","server_port":70000}]}`},
	}
	for _, input := range append([]struct{ name, format, content string }{}, inputs[:2]...) {
		input.name = strings.Replace(input.name, "uri", "base64", 1)
		input.format = "base64"
		input.content = base64.StdEncoding.EncodeToString([]byte(input.content))
		inputs = append(inputs, input)
	}
	valid := map[string]string{
		"uri-list": "socks5://accepted.example.test:1080#Accepted",
		"base64":   base64.StdEncoding.EncodeToString([]byte("socks5://accepted.example.test:1080#Accepted")),
		"mihomo":   `{"proxies":[{"name":"Accepted","type":"socks5","server":"accepted.example.test","port":1080}]}`,
		"sing-box": `{"outbounds":[{"tag":"Accepted","type":"socks","server":"accepted.example.test","server_port":1080}]}`,
	}
	for index, input := range inputs {
		for _, mode := range []string{"auto", "manual"} {
			t.Run(input.name+"/"+mode, func(t *testing.T) {
				id := fmt.Sprintf("mixed-%d-%s", index, mode)
				path := "/api/me/sources/" + id
				source := map[string]any{"id": id, "name": "Mixed import", "kind": "text", "enabled": true, "format": input.format, "content": input.content, "applyMode": mode, "acceptPartial": true}
				call := func(method, path string, body any, want int) map[string]any {
					t.Helper()
					code, result, raw := req(t, owner.c, method, srv.URL+path, owner.csrf, body)
					if code != want {
						t.Fatalf("%s %s: %d %s", method, path, code, raw)
					}
					if want == 422 && strings.Contains(raw, "synthetic-secret") {
						t.Fatal("ordinary failure response leaked input secret")
					}
					return result
				}
				failed := call("POST", "/api/me/sources", source, 422)["source"].(map[string]any)
				if failed["refreshStatus"] != "failed" || failed["lastErrorCode"] != "source_parse_failed" {
					t.Fatalf("missing typed rejection: %#v", failed)
				}
				var saved httpapi.Source
				if err := s.TenantGet(owner.id, "sources", id, &saved); err != nil {
					t.Fatal(err)
				}
				if saved.Snapshot != nil || saved.Candidate != nil || len(saved.ApplyHistory) != 0 {
					t.Fatal("first failed import stored partial accepted/candidate state")
				}
				if saved.Content != input.content {
					t.Fatal("rejected draft was not retained for correction")
				}
				source["content"] = valid[input.format]
				source["format"] = input.format
				source["revision"] = saved.Revision
				call("PUT", path, source, 200)
				if err := s.TenantGet(owner.id, "sources", id, &saved); err != nil {
					t.Fatal(err)
				}
				if saved.Snapshot == nil || len(saved.Snapshot.Endpoints) != 1 {
					t.Fatal("valid correction did not create complete snapshot")
				}
				before := saved
				profile := templateTestProfile(id, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
				profile.IR.Endpoints = nil
				profile.SourceIDs = []string{id}
				call("POST", "/api/me/profiles", profile, 200)
				created := call("POST", "/api/me/outputs", map[string]any{"id": id, "name": "Frozen mixed-import feed", "profileId": id}, 201)
				feedPath := created["feedPath"].(string)
				code, _, feedBefore := req(t, owner.c, "GET", srv.URL+feedPath, "", nil)
				if code != 200 {
					t.Fatalf("initial feed failed: %d", code)
				}
				var outputBefore httpapi.Output
				if err := s.TenantGet(owner.id, "outputs", id, &outputBefore); err != nil {
					t.Fatal(err)
				}
				source["content"], source["format"], source["revision"] = input.content, input.format, before.Revision
				call("PUT", path, source, 422)
				var after httpapi.Source
				if err := s.TenantGet(owner.id, "sources", id, &after); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(after.Snapshot, before.Snapshot) || !reflect.DeepEqual(after.ApplyHistory, before.ApplyHistory) || !reflect.DeepEqual(after.Diagnostics, before.Diagnostics) || !after.UpdatedAt.Equal(before.UpdatedAt) || after.Candidate != nil {
					t.Fatal("failed mixed update changed accepted history or exposed a partial candidate")
				}
				if after.Content != input.content || after.Revision == before.Revision || after.RefreshStatus != "failed" || after.LastErrorCode != "source_parse_failed" {
					t.Fatal("failed draft state not retained and versioned correctly")
				}
				revealed := call("GET", path+"/reveal", nil, 200)
				if revealed["content"] != input.content {
					t.Fatal("owner cannot recover rejected draft")
				}
				var outputAfter httpapi.Output
				if err := s.TenantGet(owner.id, "outputs", id, &outputAfter); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(outputBefore, outputAfter) {
					t.Fatal("failed mixed import republished frozen output")
				}
				code, _, feedAfter := req(t, owner.c, "GET", srv.URL+feedPath, "", nil)
				if code != 200 || feedAfter != feedBefore {
					t.Fatal("failed mixed import changed live feed")
				}
			})
		}
	}
}
