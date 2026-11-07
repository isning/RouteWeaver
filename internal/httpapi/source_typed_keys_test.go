package httpapi_test

import (
	"reflect"
	"strings"
	"testing"
)

func TestSourceAliasedSettingsRejectAtomicallyAndPermitExplicitCorrection(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "typed-source-owner")
	other := inviteClient(t, s, srv, "typed-source-other")
	valid := `{"outbounds":[{"type":"vless","tag":"Accepted","server":"proxy.example.test","server_port":443,"uuid":"00000000-0000-4000-8000-000000000001","tls":{"enabled":true}}]}`
	invalid := strings.Replace(valid, `"enabled":true`, `"enabled":true,"ENABLED":false`, 1)
	for _, mode := range []string{"auto", "manual"} {
		t.Run(mode, func(t *testing.T) {
			id := "typed-source-" + mode
			path := "/api/me/sources/" + id
			input := map[string]any{"id": id, "name": "Synthetic source", "kind": "text", "format": "sing-box", "enabled": true, "content": invalid, "applyMode": mode}
			call := func(method, path string, body any, want int) map[string]any {
				t.Helper()
				code, result, _ := req(t, owner.c, method, srv.URL+path, owner.csrf, body)
				if code != want {
					t.Fatalf("%s %s returned %d, want %d", method, path, code, want)
				}
				return result
			}
			failed := call("POST", "/api/me/sources", input, 422)["source"].(map[string]any)
			if failed["refreshStatus"] != "failed" || failed["lastErrorCode"] != "source_parse_failed" || failed["snapshot"] != nil || failed["candidate"] != nil || failed["applyHistory"] != nil {
				t.Fatal("ambiguous first import produced accepted or pending state")
			}
			read := call("GET", path+"/reveal", nil, 200)
			if read["content"] != invalid || read["revision"] != failed["revision"] || read["snapshot"] != nil {
				t.Fatal("initial failure was not durably retained for its owner")
			}
			code, _, _ := req(t, other.c, "GET", srv.URL+path+"/reveal", "", nil)
			if code != 404 {
				t.Fatal("another owner could reveal rejected source input")
			}
			input["content"], input["revision"] = valid, failed["revision"]
			accepted := call("PUT", path, input, 200)
			if accepted["refreshStatus"] != "accepted" || accepted["candidate"] != nil {
				t.Fatal("valid first correction did not create an accepted snapshot")
			}
			firstSnapshot := sourceSnapshotID(t, accepted)
			input["content"], input["revision"] = invalid, accepted["revision"]
			failed = call("PUT", path, input, 422)["source"].(map[string]any)
			assertRetained := func(source map[string]any) {
				t.Helper()
				if !reflect.DeepEqual(source["snapshot"], accepted["snapshot"]) || !reflect.DeepEqual(source["applyHistory"], accepted["applyHistory"]) || !reflect.DeepEqual(source["diagnostics"], accepted["diagnostics"]) || source["updatedAt"] != accepted["updatedAt"] || source["candidate"] != nil {
					t.Fatal("ambiguous reimport changed the accepted snapshot, history or diagnostics")
				}
				if source["refreshStatus"] != "failed" || source["lastErrorCode"] != "source_parse_failed" || source["revision"] == accepted["revision"] {
					t.Fatal("ambiguous reimport failure was not saved as a new draft revision")
				}
			}
			assertRetained(failed)
			assertRetained(call("GET", path, nil, 200))
			read = call("GET", path+"/reveal", nil, 200)
			if read["content"] != invalid || read["revision"] != failed["revision"] {
				t.Fatal("rejected reimport draft is not recoverable by its owner")
			}
			failed = call("POST", path+"/refresh", map[string]any{}, 422)["source"].(map[string]any)
			assertRetained(failed)
			corrected := strings.Replace(valid, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", 1)
			input["content"], input["revision"] = corrected, failed["revision"]
			updated := call("PUT", path, input, 200)
			if mode == "manual" {
				candidate, ok := updated["candidate"].(map[string]any)
				if !ok || sourceSnapshotID(t, updated) != firstSnapshot {
					t.Fatal("manual correction bypassed pending-candidate review")
				}
				updated = call("POST", path+"/apply", map[string]any{"candidateId": candidate["id"], "sourceRevision": updated["revision"]}, 200)
			}
			if updated["refreshStatus"] != "accepted" || updated["candidate"] != nil || updated["lastError"] != nil || updated["lastErrorCode"] != nil || sourceSnapshotID(t, updated) == firstSnapshot {
				t.Fatal("explicit correction did not recover source application")
			}
			read = call("GET", path+"/reveal", nil, 200)
			endpoints := read["snapshot"].(map[string]any)["endpoints"].([]any)
			connection := endpoints[0].(map[string]any)["connection"].(map[string]any)
			if read["content"] != corrected || connection["uuid"] != "00000000-0000-4000-8000-000000000002" || connection["tls"].(map[string]any)["enabled"] != true {
				t.Fatal("corrected accepted connection lost credentials or TLS")
			}
		})
	}
}
