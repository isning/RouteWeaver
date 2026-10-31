package httpapi_test

import (
	"fmt"
	"net/http"
	"routeweaver/internal/render"
	"sort"
	"strings"
	"testing"
)

func TestSourceAutomaticApplicationRetainsIdentityAndRecordsSafeChanges(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "automatic-source")
	input := map[string]any{"id": "auto-source", "name": "Airport", "kind": "text", "enabled": true, "content": "socks5://user:old-secret@one.example:1080#One\nsocks5://two.example:1080#Two"}
	status, initial, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	if status != 200 || initial["applyMode"] != "auto" {
		t.Fatalf("default automatic import: %d %s", status, raw)
	}
	before := sourceSnapshotID(t, initial)
	endpoint := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"]
	input["content"] = "socks5://user:new-secret@one.example:1080#Renamed"
	status, applied, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/auto-source", a.csrf, input)
	if status != 200 || applied["candidate"] != nil || applied["refreshStatus"] != "accepted" || sourceSnapshotID(t, applied) == before {
		t.Fatalf("automatic change was staged: %d %s", status, raw)
	}
	if applied["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"] != endpoint {
		t.Fatal("credential/name update replaced selected identity")
	}
	history, ok := applied["applyHistory"].([]any)
	if !ok || len(history) != 2 {
		t.Fatalf("missing persisted changes: %s", raw)
	}
	latest := history[0].(map[string]any)
	if latest["mode"] != "auto" || latest["beforeCount"] != float64(2) || latest["afterCount"] != float64(1) || latest["removed"] != float64(1) || latest["connectionChanged"] != float64(1) || latest["renamed"] != float64(1) || latest["id"] == "" || latest["appliedAt"] == "" {
		t.Fatalf("incorrect change summary: %s", raw)
	}
	if strings.Contains(raw, "old-secret") || strings.Contains(raw, "new-secret") {
		t.Fatal("summary leaked credentials")
	}
	status, loaded, raw := req(t, a.c, "GET", srv.URL+"/api/me/sources/auto-source", "", nil)
	if status != 200 || len(loaded["applyHistory"].([]any)) != 2 {
		t.Fatalf("history did not survive read: %s", raw)
	}
}

func TestSourceManualApplicationUsesExactPendingVersionAndPreservesOmittedMode(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "manual-source")
	b := inviteClient(t, s, srv, "other-manual")
	input := map[string]any{"id": "manual-source", "name": "Airport", "kind": "text", "applyMode": "manual", "enabled": true, "content": "socks5://one.example:1080#One", "applyHistory": []any{map[string]any{"id": "forged", "added": 999}}}
	status, initial, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	if status != 200 || initial["candidate"] != nil || initial["applyMode"] != "manual" || len(initial["applyHistory"].([]any)) != 1 {
		t.Fatalf("explicit first import not immediately usable: %d %s", status, raw)
	}
	first := sourceSnapshotID(t, initial)
	delete(input, "applyMode")
	input["content"] = "socks5://one.example:1080#Renamed\nsocks5://two.example:1080#Two"
	status, pending, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/manual-source", a.csrf, input)
	if status != 200 || pending["applyMode"] != "manual" || pending["candidate"] == nil || sourceSnapshotID(t, pending) != first || len(pending["applyHistory"].([]any)) != 1 || strings.Contains(raw, "forged") {
		t.Fatalf("manual choice/history not retained: %d %s", status, raw)
	}
	candidate := pending["candidate"].(map[string]any)
	decision := map[string]any{"candidateId": candidate["id"], "sourceRevision": pending["revision"]}
	status, read, raw := req(t, a.c, "GET", srv.URL+"/api/me/sources/manual-source", "", nil)
	if status != 200 || read["candidate"] == nil || sourceSnapshotID(t, read) != first {
		t.Fatalf("GET applied pending update: %s", raw)
	}
	status, _, _ = req(t, b.c, "POST", srv.URL+"/api/me/sources/manual-source/apply", b.csrf, decision)
	if status != 404 {
		t.Fatalf("cross-owner apply: %d", status)
	}
	bad := map[string]any{"candidateId": candidate["id"], "sourceRevision": "old"}
	status, _, _ = req(t, a.c, "POST", srv.URL+"/api/me/sources/manual-source/apply", a.csrf, bad)
	if status != 409 {
		t.Fatalf("stale revision applied: %d", status)
	}
	status, applied, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources/manual-source/apply", a.csrf, decision)
	if status != 200 || applied["candidate"] != nil || sourceSnapshotID(t, applied) == first || len(applied["applyHistory"].([]any)) != 2 {
		t.Fatalf("direct manual apply failed: %d %s", status, raw)
	}
	latest := applied["applyHistory"].([]any)[0].(map[string]any)
	if latest["mode"] != "manual" || latest["added"] != float64(1) || latest["renamed"] != float64(1) {
		t.Fatalf("manual summary: %s", raw)
	}
	status, _, _ = req(t, a.c, "POST", srv.URL+"/api/me/sources/manual-source/apply", a.csrf, decision)
	if status != 409 {
		t.Fatalf("duplicate apply was not fenced: %d", status)
	}
}

func TestSourceApplyHistoryIsBoundedAndFailuresAndNoChangesDoNotAppend(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "bounded-source")
	input := map[string]any{"id": "bounded", "name": "Airport", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#One"}
	status, current, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	if status != 200 {
		t.Fatal(raw)
	}
	for i := 0; i < 24; i++ {
		input["name"] = fmt.Sprintf("Airport %d", i)
		status, current, raw = req(t, a.c, "PUT", srv.URL+"/api/me/sources/bounded", a.csrf, input)
		if status != 200 {
			t.Fatal(raw)
		}
	}
	history := current["applyHistory"].([]any)
	if len(history) != 20 {
		t.Fatalf("history unbounded: %d", len(history))
	}
	latest := history[0].(map[string]any)["id"]
	seen := map[any]bool{}
	for _, entry := range history {
		event := entry.(map[string]any)
		if seen[event["id"]] {
			t.Fatal("duplicate event identity")
		}
		seen[event["id"]] = true
		if len(event) != 10 {
			t.Fatalf("unexpected history fields: %+v", event)
		}
	}
	snapshot := sourceSnapshotID(t, current)
	status, unchanged, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources/bounded/refresh", a.csrf, map[string]any{})
	if status != 200 || sourceSnapshotID(t, unchanged) != snapshot || unchanged["applyHistory"].([]any)[0].(map[string]any)["id"] != latest {
		t.Fatalf("unchanged created event: %s", raw)
	}
	input["content"] = "<html>login-secret</html>"
	status, failed, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/bounded", a.csrf, input)
	if status != 422 || strings.Contains(raw, "login-secret") {
		t.Fatalf("invalid update: %s", raw)
	}
	retained := failed["source"].(map[string]any)
	if sourceSnapshotID(t, retained) != snapshot || retained["applyHistory"].([]any)[0].(map[string]any)["id"] != latest {
		t.Fatal("failure changed active snapshot/history")
	}
	input["content"] = `{"proxies":[]}`
	status, empty, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/bounded", a.csrf, input)
	if status != 200 || empty["candidate"] != nil || len(empty["snapshot"].(map[string]any)["endpoints"].([]any)) != 0 || empty["applyHistory"].([]any)[0].(map[string]any)["removed"] != float64(1) {
		t.Fatalf("valid empty update was gated: %s", raw)
	}
}

func TestSourceApplyModeRejectsUnknownBeforeMutationAndAutoSwitchApplies(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "switch-source")
	input := map[string]any{"id": "switch", "name": "Airport", "kind": "text", "applyMode": "manual", "enabled": true, "content": "socks5://one.example:1080#One"}
	_, initial, _ := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	input["applyMode"] = "unexpected"
	input["content"] = "socks5://two.example:1080#Two"
	status, _, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/switch", a.csrf, input)
	if status != 400 {
		t.Fatalf("unknown mode accepted: %s", raw)
	}
	_, loaded, _ := req(t, a.c, "GET", srv.URL+"/api/me/sources/switch", "", nil)
	if loaded["revision"] != initial["revision"] {
		t.Fatal("invalid mode mutated source")
	}
	input["applyMode"] = "manual"
	_, pending, _ := req(t, a.c, "PUT", srv.URL+"/api/me/sources/switch", a.csrf, input)
	if pending["candidate"] == nil {
		t.Fatal("manual update not pending")
	}
	input["applyMode"] = "auto"
	status, applied, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/switch", a.csrf, input)
	if status != 200 || applied["candidate"] != nil || applied["applyMode"] != "auto" || sourceSnapshotID(t, applied) == sourceSnapshotID(t, initial) {
		t.Fatalf("explicit auto switch did not apply: %s", raw)
	}
}

func TestLegacySourceReadNeverAppliesPendingCandidate(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "legacy-source")
	input := map[string]any{"id": "legacy", "name": "Airport", "kind": "text", "applyMode": "manual", "enabled": true, "content": "socks5://one.example:1080#One"}
	_, initial, _ := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	input["content"] = "socks5://two.example:1080#Two"
	_, pending, _ := req(t, a.c, "PUT", srv.URL+"/api/me/sources/legacy", a.csrf, input)
	// Seed the supported old-record shape at the persistence interface.
	var legacy map[string]any
	if err := s.TenantGet(a.id, "sources", "legacy", &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "applyMode")
	if err := s.TenantPut(a.id, "sources", "legacy", legacy); err != nil {
		t.Fatal(err)
	}
	status, read, raw := req(t, a.c, "GET", srv.URL+"/api/me/sources/legacy", "", nil)
	if status != 200 || read["applyMode"] != "auto" || read["candidate"] == nil || read["revision"] != pending["revision"] || sourceSnapshotID(t, read) != sourceSnapshotID(t, initial) {
		t.Fatalf("legacy read mutated application: %s", raw)
	}
	decision := map[string]any{"candidateId": read["candidate"].(map[string]any)["id"], "sourceRevision": read["revision"]}
	status, applied, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources/legacy/apply", a.csrf, decision)
	if status != 200 || applied["candidate"] != nil || sourceSnapshotID(t, applied) == sourceSnapshotID(t, initial) {
		t.Fatalf("legacy explicit apply failed: %s", raw)
	}
	if applied["applyHistory"].([]any)[0].(map[string]any)["mode"] != "manual" {
		t.Fatal("explicit legacy application mislabeled automatic")
	}
}

func TestSourceAutomaticReplacementPreservesPublishedFeedAndMissingSelectionGate(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "publication-source")
	input := map[string]any{"id": "published-source", "name": "Airport", "kind": "text", "enabled": true, "content": "socks5://one.example:1080#Same"}
	_, initial, _ := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	endpoint := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"].(string)
	profile := map[string]any{"id": "selected-profile", "name": "Selected profile", "sourceIds": []string{"published-source"}, "target": map[string]any{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "defaultAction": map[string]any{"kind": "endpoint", "ref": endpoint}, "runtime": map[string]any{"mixedPort": 7890}}}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, profile)
	if status != 200 {
		t.Fatal(raw)
	}
	status, out, raw := req(t, a.c, "POST", srv.URL+"/api/me/outputs", a.csrf, map[string]any{"id": "selected-output", "name": "Selected output", "profileId": "selected-profile"})
	if status != 201 {
		t.Fatal(raw)
	}
	status, _, before := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if status != 200 {
		t.Fatal(before)
	}
	_, _, draftBefore := req(t, a.c, "GET", srv.URL+"/api/me/profiles/selected-profile", "", nil)
	input["content"] = "socks5://different.example:1080#Same"
	status, updated, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/published-source", a.csrf, input)
	if status != 200 || updated["candidate"] != nil {
		t.Fatalf("auto update failed: %s", raw)
	}
	replacement := updated["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"].(string)
	if replacement == endpoint {
		t.Fatal("same display name silently reused selected identity for another address")
	}
	_, _, draftAfter := req(t, a.c, "GET", srv.URL+"/api/me/profiles/selected-profile", "", nil)
	if draftAfter != draftBefore {
		t.Fatal("source application rewrote saved profile")
	}
	status, blocked, raw := req(t, a.c, "POST", srv.URL+"/api/me/profiles/selected-profile/preview", a.csrf, map[string]any{"outputId": "selected-output"})
	if status != 422 || blocked["validation"].(map[string]any)["code"] != "missing_action_reference" {
		t.Fatalf("missing selected identity was not fenced: %d %s", status, raw)
	}
	status, _, after := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if status != 200 || after != before {
		t.Fatal("source automatic application changed published feed")
	}
	status, loaded, raw := req(t, a.c, "GET", srv.URL+"/api/me/outputs/selected-output/status", "", nil)
	if status != 200 || loaded["revision"] != out["revision"] {
		t.Fatalf("source application changed output revision: %d %s", status, raw)
	}
}

func TestSourceConcurrentManualApplyCommitsExactlyOneHistoryEvent(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "apply-race")
	input := map[string]any{"id": "racing", "name": "Airport", "kind": "text", "applyMode": "manual", "enabled": true, "content": "socks5://one.example:1080#One"}
	_, _, _ = req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, input)
	input["content"] = "socks5://two.example:1080#Two"
	_, pending, _ := req(t, a.c, "PUT", srv.URL+"/api/me/sources/racing", a.csrf, input)
	decision := map[string]any{"candidateId": pending["candidate"].(map[string]any)["id"], "sourceRevision": pending["revision"]}
	start := make(chan struct{})
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			status, _, _ := req(t, a.c, "POST", srv.URL+"/api/me/sources/racing/apply", a.csrf, decision)
			results <- status
		}()
	}
	close(start)
	statuses := []int{<-results, <-results}
	sort.Ints(statuses)
	if statuses[0] != 200 || statuses[1] != 409 {
		t.Fatalf("expected one commit and one stale result, got %v", statuses)
	}
	_, current, raw := req(t, a.c, "GET", srv.URL+"/api/me/sources/racing", "", nil)
	if current["candidate"] != nil || len(current["applyHistory"].([]any)) != 2 {
		t.Fatalf("duplicate commit/history: %s", raw)
	}
}
