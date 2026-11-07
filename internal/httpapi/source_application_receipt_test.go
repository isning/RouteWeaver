package httpapi_test

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/render"
)

func TestSourceApplicationReceiptUsesCommittedCurrentDependencies(t *testing.T) {
	for _, action := range []string{"apply", "candidate/accept"} {
		t.Run(action, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "receipt-owner")
			other := inviteClient(t, s, srv, "receipt-other")
			call := func(actor sessionClient, method, path string, input any, want int) map[string]any {
				t.Helper()
				code, value, body := req(t, actor.c, method, srv.URL+"/api/me"+path, actor.csrf, input)
				if code != want {
					t.Fatalf("%s %s: status %d, want %d", method, path, code, want)
				}
				if code != 200 && code != 201 && strings.Contains(body, `"application"`) {
					t.Fatal("uncommitted response contained an application receipt")
				}
				return value
			}
			source := map[string]any{"id": "source", "name": "Airport", "kind": "text", "enabled": true, "applyMode": "manual", "content": "socks5://user:before-secret@one.example:1080#One"}
			initial := call(owner, "POST", "/sources", source, 200)
			endpoint := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"]
			profile := func(id, name string) map[string]any {
				return map[string]any{"id": id, "name": name, "sourceIds": []string{"source"}, "target": map[string]any{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "defaultAction": map[string]any{"kind": "endpoint", "ref": endpoint}, "runtime": map[string]any{"mixedPort": 7890}}}
			}
			call(owner, "POST", "/profiles", profile("kept", "Old routing name"), 200)
			call(owner, "POST", "/profiles", profile("deleted", "Deleted routing"), 200)
			outputs := map[string]map[string]any{}
			for _, id := range []string{"chosen", "sibling", "revoked"} {
				outputs[id] = call(owner, "POST", "/outputs", map[string]any{"id": id, "name": id, "profileId": "kept"}, 201)
			}
			feed := func(id string) string {
				t.Helper()
				code, _, body := req(t, http.DefaultClient, "GET", srv.URL+outputs[id]["feedPath"].(string), "", nil)
				if code != 200 {
					t.Fatalf("%s feed: status %d", id, code)
				}
				return body
			}
			beforeFeeds := map[string]string{"chosen": feed("chosen"), "sibling": feed("sibling")}
			beforeAccess := map[string]string{}
			for _, id := range []string{"chosen", "sibling"} {
				path, ok := call(owner, "GET", "/outputs/"+id+"/access", nil, 200)["feedPath"].(string)
				if !ok || path == "" {
					t.Fatal("fixture has no current subscription access path")
				}
				beforeAccess[id] = path
			}
			if !strings.Contains(beforeFeeds["chosen"], "before-secret") {
				t.Fatal("fixture does not deliver the accepted source credential")
			}
			source["content"] = "socks5://user:after-secret@one.example:1080#One"
			pending := call(owner, "PUT", "/sources/source", source, 200)
			candidate := pending["candidate"].(map[string]any)
			reviewed, _ := json.Marshal(candidate["affected"])
			if !strings.Contains(string(reviewed), "Old routing name") || !strings.Contains(string(reviewed), "Deleted routing") || !strings.Contains(string(reviewed), `"id":"revoked"`) || strings.Contains(string(reviewed), "New routing") {
				t.Fatal("fixture did not capture the earlier dependency set")
			}
			decision := map[string]any{"candidateId": candidate["id"], "sourceRevision": pending["revision"]}
			// Change dependencies after review without changing its exact source candidate.
			saveCurrentProfileDraft(t, owner, srv.URL+"/api/me/profiles/kept", profile("kept", "Current before-secret after-secret"))
			call(owner, "DELETE", "/profiles/deleted", nil, 200)
			call(owner, "POST", "/outputs/revoked/revoke", map[string]any{}, 200)
			call(owner, "POST", "/profiles", profile("added", "New routing"), 200)
			call(owner, "POST", "/outputs", map[string]any{"id": "added-output", "name": "New subscription", "profileId": "added"}, 201)
			// A same-ID source in another tenant must not contribute related targets.
			otherSource := call(other, "POST", "/sources", source, 200)
			otherEndpoint := otherSource["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"]
			otherProfile := profile("other-profile", "Other tenant private routing")
			otherProfile["ir"].(map[string]any)["defaultAction"] = map[string]any{"kind": "endpoint", "ref": otherEndpoint}
			call(other, "POST", "/profiles", otherProfile, 200)
			call(other, "POST", "/outputs", map[string]any{"id": "other-output", "name": "Other tenant private subscription", "profileId": "other-profile"}, 201)
			beforeProfiles := map[string]map[string]any{}
			for _, id := range []string{"kept", "added"} {
				beforeProfiles[id] = call(owner, "GET", "/profiles/"+id+"/reveal", nil, 200)
			}
			call(owner, "POST", "/sources/source/"+action, map[string]any{"candidateId": candidate["id"], "sourceRevision": initial["revision"]}, 409)
			applied := call(owner, "POST", "/sources/source/"+action, decision, 200)
			receipt, ok := applied["application"].(map[string]any)
			if !ok || len(receipt) != 3 || receipt["candidateId"] != candidate["id"] || receipt["sourceRevision"] != applied["revision"] || applied["revision"] == pending["revision"] {
				t.Fatal("application receipt does not identify the exact committed candidate and new source revision")
			}
			if applied["candidate"] != nil || sourceSnapshotID(t, applied) == sourceSnapshotID(t, initial) {
				t.Fatal("receipt did not accompany accepted source data")
			}
			got := map[string]string{}
			for _, value := range receipt["affected"].([]any) {
				impact := value.(map[string]any)
				key := impact["kind"].(string) + ":" + impact["id"].(string)
				if _, duplicate := got[key]; duplicate {
					t.Fatal("duplicate related target")
				}
				got[key] = impact["name"].(string)
			}
			want := map[string]string{"profile:kept": "Current [REDACTED] [REDACTED]", "default:kept": "Current [REDACTED] [REDACTED]", "profile:added": "New routing", "default:added": "New routing", "subscription:chosen": "chosen", "subscription:sibling": "sibling", "subscription:added-output": "New subscription"}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("receipt did not reflect current added, renamed, deleted and revoked dependencies")
			}
			encoded, err := json.Marshal(receipt)
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"before-secret", "after-secret", "one.example", "Other tenant", `"snapshot"`, `"inputs"`, `"sets"`, `"content"`} {
				if strings.Contains(string(encoded), private) {
					t.Fatal("receipt disclosed private source material or another tenant's impact")
				}
			}
			for _, id := range []string{"chosen", "sibling"} {
				if feed(id) != beforeFeeds[id] || call(owner, "GET", "/outputs/"+id+"/status", nil, 200)["revision"] != outputs[id]["revision"] {
					t.Fatal("source application changed frozen subscription bytes or revision")
				}
				if call(owner, "GET", "/outputs/"+id+"/access", nil, 200)["feedPath"] != beforeAccess[id] {
					t.Fatal("source application changed current subscription access")
				}
			}
			for id, before := range beforeProfiles {
				if !reflect.DeepEqual(call(owner, "GET", "/profiles/"+id+"/reveal", nil, 200), before) {
					t.Fatal("source application rewrote a saved profile recipe")
				}
			}
			for _, path := range []string{"/sources/source", "/sources/source/reveal", "/sources"} {
				code, _, body := req(t, owner.c, "GET", srv.URL+"/api/me"+path, "", nil)
				if code != 200 || strings.Contains(body, `"application"`) || strings.Contains(body, "New routing") {
					t.Fatal("response-only application detail was retained in a source read")
				}
			}
			for _, entry := range applied["applyHistory"].([]any) {
				if len(entry.(map[string]any)) != 10 {
					t.Fatal("count-only source history acquired application detail")
				}
			}
			call(owner, "POST", "/sources/source/"+action, decision, 409)
			source["content"] = "socks5://user:third-secret@one.example:1080#One"
			next := call(owner, "PUT", "/sources/source", source, 200)
			rejected := call(owner, "POST", "/sources/source/candidate/reject", map[string]any{"candidateId": next["candidate"].(map[string]any)["id"], "sourceRevision": next["revision"]}, 200)
			if rejected["application"] != nil || rejected["candidate"] != nil || sourceSnapshotID(t, rejected) != sourceSnapshotID(t, applied) {
				t.Fatal("rejection returned an application receipt or changed accepted data")
			}
			source["content"] = "<html>invalid-source-content</html>"
			call(owner, "PUT", "/sources/source", source, 422)
		})
	}
}

func TestSourceApplicationReceiptWithoutDependenciesReturnsAuthoritativeEmptyList(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "empty-receipt")
	source := map[string]any{"id": "source", "name": "Airport", "kind": "text", "enabled": true, "applyMode": "manual", "content": "socks5://one.example:1080#One"}
	code, _, _ := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, source)
	if code != 200 {
		t.Fatalf("initial import: status %d", code)
	}
	source["content"] = "socks5://one.example:1080#Renamed"
	code, pending, _ := req(t, owner.c, "PUT", srv.URL+"/api/me/sources/source", owner.csrf, source)
	if code != 200 || pending["candidate"] == nil {
		t.Fatal("manual change did not create a candidate")
	}
	decision := map[string]any{"candidateId": pending["candidate"].(map[string]any)["id"], "sourceRevision": pending["revision"]}
	code, applied, _ := req(t, owner.c, "POST", srv.URL+"/api/me/sources/source/apply", owner.csrf, decision)
	if code != 200 {
		t.Fatalf("apply: status %d", code)
	}
	receipt, ok := applied["application"].(map[string]any)
	if !ok || receipt["candidateId"] != decision["candidateId"] || receipt["sourceRevision"] != applied["revision"] {
		t.Fatal("missing correlated application receipt")
	}
	affected, ok := receipt["affected"].([]any)
	if !ok || len(affected) != 0 {
		t.Fatal("no dependencies must be an authoritative empty array, not missing or null")
	}
}
