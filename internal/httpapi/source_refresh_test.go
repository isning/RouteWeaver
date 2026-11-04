package httpapi_test

import (
	"encoding/json"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func sourceSnapshotID(t *testing.T, source map[string]any) string {
	t.Helper()
	snapshot, ok := source["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("missing accepted snapshot: %+v", source)
	}
	return snapshot["snapshotId"].(string)
}
func TestSourceRefreshMaterialCandidateRequiresExactAcceptance(t *testing.T) {
	s, srv := makeServer(t)
	alice := inviteClient(t, s, srv, "candidate-alice")
	bob := inviteClient(t, s, srv, "candidate-bob")
	source := map[string]any{"id": "candidate-source", "applyMode": "manual", "name": "My airport", "kind": "text", "format": "uri-list", "enabled": true, "content": "socks5://user:first-secret@one.example:1080#One\nsocks5://two.example:1080#Two"}
	status, accepted, raw := req(t, alice.c, "POST", srv.URL+"/api/me/sources", alice.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	first := sourceSnapshotID(t, accepted)
	source["content"] = "socks5://user:rotated-secret@one.example:1080#Renamed"
	status, pending, raw := req(t, alice.c, "PUT", srv.URL+"/api/me/sources/candidate-source", alice.csrf, source)
	if status != 200 {
		t.Fatalf("candidate preparation: %d %s", status, raw)
	}
	candidate, ok := pending["candidate"].(map[string]any)
	if !ok {
		t.Fatalf("material update replaced accepted snapshot without review: %s", raw)
	}
	if sourceSnapshotID(t, pending) != first {
		t.Fatal("accepted snapshot changed before acceptance")
	}
	if strings.Contains(raw, "rotated-secret") || strings.Contains(raw, "first-secret") {
		t.Fatal("candidate summary leaked credentials")
	}
	changes := candidate["diff"].(map[string]any)["connectionChanged"].([]any)
	if len(changes) != 1 {
		t.Fatalf("missing credential-change row: %s", raw)
	}
	connection := changes[0].(map[string]any)
	if connection["beforeConnection"] != "socks one.example:1080" || connection["afterConnection"] != "socks one.example:1080" {
		t.Fatalf("credential-only change must keep safe endpoint context: %s", raw)
	}
	decision := map[string]any{"candidateId": candidate["id"], "sourceRevision": pending["revision"]}
	status, _, raw = req(t, bob.c, "POST", srv.URL+"/api/me/sources/candidate-source/candidate/accept", bob.csrf, decision)
	if status != 404 {
		t.Fatalf("cross-owner candidate action: %d %s", status, raw)
	}
	status, updated, raw := req(t, alice.c, "POST", srv.URL+"/api/me/sources/candidate-source/candidate/accept", alice.csrf, decision)
	if status != 200 || updated["candidate"] != nil || sourceSnapshotID(t, updated) == first {
		t.Fatalf("accept failed: %d %s", status, raw)
	}
	status, _, _ = req(t, alice.c, "POST", srv.URL+"/api/me/sources/candidate-source/candidate/accept", alice.csrf, decision)
	if status != 409 {
		t.Fatalf("replayed acceptance should be stale, got %d", status)
	}
	status, _, raw = req(t, alice.c, "GET", srv.URL+"/api/me/sources/candidate-source/reveal", "", nil)
	if status != 200 || !strings.Contains(raw, "rotated-secret") {
		t.Fatal("accepted owner-private credential unavailable")
	}
	var private map[string]any
	if err := s.TenantGet(alice.id, "sources", "candidate-source", &private); err != nil {
		t.Fatal(err)
	}
	if _, err := json.Marshal(private); err != nil {
		t.Fatal(err)
	}
}

func TestSourceRefreshUnchangedKeepsSnapshotAndHarmlessRenamePreservesIdentity(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "quiet-refresh")
	source := map[string]any{"id": "quiet", "name": "Airport", "kind": "text", "content": "socks5://one.example:1080#One", "enabled": true}
	status, initial, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	snapshot := sourceSnapshotID(t, initial)
	status, next, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources/quiet/refresh", a.csrf, map[string]any{})
	if status != 200 || next["candidate"] != nil || sourceSnapshotID(t, next) != snapshot || next["refreshStatus"] != "unchanged" {
		t.Fatalf("unchanged fetch should preserve identity without review: %d %s", status, raw)
	}
	endpoint := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"]
	source["content"] = "socks5://one.example:1080#Renamed\nsocks5://two.example:1080#Two"
	status, next, raw = req(t, a.c, "PUT", srv.URL+"/api/me/sources/quiet", a.csrf, source)
	if status != 200 || next["candidate"] != nil {
		t.Fatalf("harmless additions/rename unnecessarily blocked: %s", raw)
	}
	if next["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"] != endpoint {
		t.Fatal("rename changed stable identity")
	}
}

func TestSourceValidEmptyRequiresReviewAndFailedEditedInputRemainsSaved(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "empty-refresh")
	source := map[string]any{"id": "empty", "applyMode": "manual", "name": "Airport", "kind": "text", "format": "auto", "content": "socks5://one.example:1080#One", "enabled": true}
	_, initial, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	snapshot := sourceSnapshotID(t, initial)
	source["content"] = `{"proxies":[]}`
	status, pending, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/empty", a.csrf, source)
	if status != 200 || pending["candidate"] == nil || sourceSnapshotID(t, pending) != snapshot {
		t.Fatalf("empty feed is a removal candidate: %d %s", status, raw)
	}
	c := pending["candidate"].(map[string]any)
	d := c["diff"].(map[string]any)
	if d["afterCount"] != float64(0) || len(d["removed"].([]any)) != 1 {
		t.Fatalf("missing removal diff: %s", raw)
	}
	decision := map[string]any{"candidateId": c["id"], "sourceRevision": pending["revision"]}
	status, rejected, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources/empty/candidate/reject", a.csrf, decision)
	if status != 200 || rejected["candidate"] != nil || sourceSnapshotID(t, rejected) != snapshot {
		t.Fatalf("reject lost accepted data: %s", raw)
	}
	source["content"] = "<html>private-invalid-edit</html>"
	status, failed, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/empty", a.csrf, source)
	if status != 422 {
		t.Fatalf("invalid input accepted: %s", raw)
	}
	saved := failed["source"].(map[string]any)
	if sourceSnapshotID(t, saved) != snapshot || saved["candidate"] != nil || strings.Contains(raw, "private-invalid-edit") {
		t.Fatalf("last-good or redaction failed: %s", raw)
	}
	status, _, raw = req(t, a.c, "GET", srv.URL+"/api/me/sources/empty/reveal", "", nil)
	if status != 200 || !strings.Contains(raw, "private-invalid-edit") {
		t.Fatal("failed edited input was discarded")
	}
	source["kind"] = "url"
	source["url"] = "https://localhost/private-token"
	delete(source, "content")
	status, failed, raw = req(t, a.c, "PUT", srv.URL+"/api/me/sources/empty", a.csrf, source)
	if status != 422 || sourceSnapshotID(t, failed["source"].(map[string]any)) != snapshot || strings.Contains(raw, "private-token") {
		t.Fatalf("safe-fetch denial lost snapshot/leaked URL: %d %s", status, raw)
	}
}

func TestSourceManualApplicationRecomputesDependenciesWithoutRepublishing(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "dependent-refresh")
	source := map[string]any{"id": "dependent", "applyMode": "manual", "name": "Airport", "kind": "text", "content": "socks5://user:before-secret@one.example:1080#One", "enabled": true}
	_, initial, _ := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	endpoint := initial["snapshot"].(map[string]any)["endpoints"].([]any)[0].(map[string]any)["id"]
	collection := map[string]any{"id": "collection", "name": "Travel collection", "sources": []any{map[string]any{"sourceId": "dependent", "steps": []any{}}}, "steps": []any{}}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/collections", a.csrf, collection)
	if status != 200 {
		t.Fatal(raw)
	}
	profile := map[string]any{"id": "profile", "name": "Travel profile", "collectionId": "collection", "target": map[string]any{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"schemaVersion": "1.0", "groups": []any{map[string]any{"id": "selection", "name": "ChatGPT", "kind": "manual", "members": []any{map[string]any{"kind": "endpoint", "ref": endpoint}}}}, "defaultAction": map[string]any{"kind": "group", "ref": "selection"}, "runtime": map[string]any{"mixedPort": 7890}}}
	ir := profile["ir"].(map[string]any)
	ir["groups"] = append(ir["groups"].([]any), map[string]any{"id": "nested", "name": "Nested routing", "kind": "manual", "members": []any{map[string]any{"kind": "group", "ref": "selection"}}})
	ir["defaultAction"] = map[string]any{"kind": "group", "ref": "nested"}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, profile)
	if status != 200 {
		t.Fatal(raw)
	}
	status, published, raw := req(t, a.c, "POST", srv.URL+"/api/me/outputs", a.csrf, map[string]any{"id": "feed", "name": "Travel subscription", "profileId": "profile"})
	if status != 201 {
		t.Fatalf("publish fixture: %d %s", status, raw)
	}
	_, feedBefore, _ := req(t, a.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	_ = feedBefore
	source["content"] = "socks5://user:after-secret@one.example:1080#One"
	status, pending, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/dependent", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	c := pending["candidate"].(map[string]any)
	for _, name := range []string{"Travel collection", "Travel profile", "ChatGPT", "Nested routing", "Travel subscription"} {
		if !strings.Contains(raw, name) {
			t.Fatalf("missing affected name %q: %s", name, raw)
		}
	}
	if strings.Contains(raw, "before-secret") || strings.Contains(raw, "after-secret") || strings.Contains(raw, "\"inputs\"") {
		t.Fatalf("review exposes private manifest: %s", raw)
	}
	diff := c["diff"].(map[string]any)
	changed := diff["connectionChanged"].([]any)
	if len(changed) != 1 || changed[0].(map[string]any)["fields"].([]any)[0] != "password" {
		t.Fatalf("expected field-only credential rotation diff: %s", raw)
	}
	decision := map[string]any{"candidateId": c["id"], "sourceRevision": pending["revision"]}
	// A new dependent profile after fetching is included in the current apply
	// transaction, rather than forcing a second obsolete review workflow.
	profile["id"] = "new-profile"
	profile["name"] = "New selection"
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, profile)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/sources/dependent/apply", a.csrf, decision)
	if status != 200 {
		t.Fatalf("new dependency incorrectly blocked application: %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/sources/dependent/candidate/accept", a.csrf, decision)
	if status != 409 {
		t.Fatalf("old applied candidate was replayed: %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if status != 200 || !strings.Contains(raw, published["revision"].(string)) {
		t.Fatalf("source acceptance silently republished subscription: %s", raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/outputs/feed/revoke", a.csrf, map[string]any{})
	if status != 200 {
		t.Fatal(raw)
	}
	source["content"] = "socks5://user:third-secret@one.example:1080#One"
	status, _, raw = req(t, a.c, "PUT", srv.URL+"/api/me/sources/dependent", a.csrf, source)
	if status != 200 || strings.Contains(raw, "Travel subscription") {
		t.Fatalf("revoked output represented as a published subscription: %s", raw)
	}
}

func TestSourceAutomaticDynamicAdditionDoesNotRequireReview(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "dynamic-refresh")
	source := map[string]any{"id": "dynamic", "name": "Airport", "kind": "text", "content": "socks5://one.example:1080#One", "enabled": true}
	status, _, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	profile := map[string]any{"id": "dynamic-profile", "name": "Dynamic profile", "sourceIds": []string{"dynamic"}, "target": map[string]any{"adapterId": "mihomo", "version": render.MihomoVersion}, "mode": "full", "ir": map[string]any{"groups": []any{map[string]any{"id": "automatic", "name": "Matching airport options", "kind": "manual", "members": []any{}, "dynamic": map[string]any{"sourceId": "dynamic"}}}, "defaultAction": map[string]any{"kind": "group", "ref": "automatic"}, "runtime": map[string]any{"mixedPort": 7890}}}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/profiles", a.csrf, profile)
	if status != 200 {
		t.Fatal(raw)
	}
	source["content"] = "socks5://one.example:1080#One\nsocks5://two.example:1080#Two"
	status, pending, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/dynamic", a.csrf, source)
	if status != 200 || pending["candidate"] != nil || pending["refreshStatus"] != "accepted" {
		t.Fatalf("automatic dynamic addition was unnecessarily gated: %s", raw)
	}
}

func TestSourceCandidateRevealStaleEditDeletionAndInvalidPartial(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "candidate-security")
	b := inviteClient(t, s, srv, "candidate-other")
	source := map[string]any{"id": "secure", "applyMode": "manual", "name": "Airport", "kind": "text", "content": "vless://00000000-0000-4000-8000-000000000001@proxy.example:443?type=ws&security=tls&path=%2Fws%3Ftoken%3Dold-url-secret#London", "enabled": true}
	status, initial, raw := req(t, a.c, "POST", srv.URL+"/api/me/sources", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	first := sourceSnapshotID(t, initial)
	source["content"] = "vless://00000000-0000-4000-8000-000000000002@proxy.example:443?type=ws&security=tls&path=%2Fws%3Ftoken%3Dnew-url-secret#London"
	status, pending, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/secure", a.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	for _, path := range []string{"/api/me/sources", "/api/me/sources/secure", "/api/me/sources/secure/candidate"} {
		status, _, raw = req(t, a.c, "GET", srv.URL+path, "", nil)
		for _, secret := range []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "old-url-secret", "new-url-secret", "\"inputs\"", "\"sets\""} {
			if strings.Contains(raw, secret) {
				t.Fatalf("%s leaks %s", path, secret)
			}
		}
	}
	status, _, raw = req(t, a.c, "GET", srv.URL+"/api/me/sources/secure/candidate/reveal", "", nil)
	if status != 200 || !strings.Contains(raw, "new-url-secret") || !strings.Contains(raw, "00000000-0000-4000-8000-000000000002") {
		t.Fatalf("explicit candidate reveal missing: %s", raw)
	}
	status, _, raw = req(t, b.c, "GET", srv.URL+"/api/me/sources/secure/candidate/reveal", "", nil)
	if status != 404 {
		t.Fatalf("candidate reveal IDOR: %d %s", status, raw)
	}
	candidate := pending["candidate"].(map[string]any)
	decision := map[string]any{"candidateId": candidate["id"], "sourceRevision": pending["revision"]}
	source["content"] = "socks5://good.example:1080#Good\nunsupported://partial-secret@bad.example:443"
	source["revision"] = pending["revision"]
	status, failed, raw := req(t, a.c, "PUT", srv.URL+"/api/me/sources/secure", a.csrf, source)
	if status != 422 || sourceSnapshotID(t, failed["source"].(map[string]any)) != first {
		t.Fatalf("partial import discarded accepted snapshot: %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/sources/secure/candidate/accept", a.csrf, decision)
	if status != 409 {
		t.Fatalf("stale candidate after edit accepted: %d %s", status, raw)
	}
	status, _, raw = req(t, a.c, "DELETE", srv.URL+"/api/me/sources/secure", a.csrf, nil)
	if status != 200 {
		t.Fatal(raw)
	}
	status, _, raw = req(t, a.c, "POST", srv.URL+"/api/me/sources/secure/candidate/reject", a.csrf, decision)
	if status != 404 {
		t.Fatalf("deleted source candidate remained: %d %s", status, raw)
	}
}

func TestSourceCandidateDistinguishesSameNameConnectionReplacementWithoutCredentials(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "summary-owner")
	source := map[string]any{"id": "summary-source", "applyMode": "manual", "name": "Airport", "kind": "text", "format": "uri-list", "enabled": true, "content": "socks5://fixture-user:fixture-secret@[2001:db8::50]:1080#Same"}
	status, _, raw := req(t, user.c, "POST", srv.URL+"/api/me/sources", user.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	source["content"] = "socks5://fixture-user:fixture-secret@[2001:db8::50]:1081#Same"
	status, result, raw := req(t, user.c, "PUT", srv.URL+"/api/me/sources/summary-source", user.csrf, source)
	if status != 200 {
		t.Fatal(raw)
	}
	candidate, ok := result["candidate"].(map[string]any)
	if !ok {
		t.Fatalf("replacement needs review: %s", raw)
	}
	diff := candidate["diff"].(map[string]any)
	removed := diff["removed"].([]any)[0].(map[string]any)
	added := diff["added"].([]any)[0].(map[string]any)
	if removed["beforeConnection"] != "socks [2001:db8::50]:1080" || added["afterConnection"] != "socks [2001:db8::50]:1081" {
		t.Fatalf("missing distinguishable summaries: %s", raw)
	}
	if strings.Contains(raw, "fixture-user") || strings.Contains(raw, "fixture-secret") {
		t.Fatal("connection summary leaked credentials")
	}
	if candidate["snapshot"] != nil || candidate["inputs"] != nil {
		t.Fatal("private candidate state exposed")
	}
}

func TestSourceFailureCodeIsServerOwnedAndRetainsPrivateInput(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "failure-code-owner")
	other := inviteClient(t, s, srv, "failure-code-other")
	source := map[string]any{"id": "typed-failure", "name": "Synthetic source", "kind": "url", "enabled": true, "url": "https://localhost/sub?token=synthetic-secret", "lastErrorCode": "source_fetch_timeout"}
	status, failed, raw := req(t, owner.c, "POST", srv.URL+"/api/me/sources", owner.csrf, source)
	if status != 422 {
		t.Fatalf("expected retained denial: %d %s", status, raw)
	}
	retained := failed["source"].(map[string]any)
	if retained["lastErrorCode"] != "source_url_not_allowed" || retained["refreshStatus"] != "failed" || retained["revision"] == "" || retained["snapshot"] != nil || retained["candidate"] != nil {
		t.Fatalf("missing trusted failure metadata: %s", raw)
	}
	if strings.Contains(raw, "synthetic-secret") || strings.Contains(raw, "localhost") {
		t.Fatal("failure leaked source URL")
	}
	for _, path := range []string{"/api/me/sources", "/api/me/sources/typed-failure"} {
		status, _, raw = req(t, owner.c, "GET", srv.URL+path, "", nil)
		if status != 200 || !strings.Contains(raw, `"lastErrorCode":"source_url_not_allowed"`) || strings.Contains(raw, "synthetic-secret") {
			t.Fatalf("redacted projection: %d %s", status, raw)
		}
	}
	status, revealed, raw := req(t, owner.c, "GET", srv.URL+"/api/me/sources/typed-failure/reveal", "", nil)
	if status != 200 || revealed["url"] != source["url"] || revealed["revision"] != retained["revision"] || revealed["lastErrorCode"] != "source_url_not_allowed" {
		t.Fatalf("owner reveal lost retained state: %d %s", status, raw)
	}
	for _, path := range []string{"/api/me/sources/typed-failure", "/api/me/sources/typed-failure/reveal"} {
		status, _, raw = req(t, other.c, "GET", srv.URL+path, "", nil)
		if status != 404 || strings.Contains(raw, "synthetic-secret") || strings.Contains(raw, "source_url_not_allowed") {
			t.Fatalf("cross-owner failure metadata: %d %s", status, raw)
		}
	}
	source["kind"] = "text"
	delete(source, "url")
	source["content"] = "socks5://synthetic.example:1080#Kept"
	source["lastErrorCode"] = "source_url_not_allowed"
	status, accepted, raw := req(t, owner.c, "PUT", srv.URL+"/api/me/sources/typed-failure", owner.csrf, source)
	if status != 200 || accepted["lastErrorCode"] != nil || accepted["lastError"] != nil {
		t.Fatalf("success retained forged/stale code: %d %s", status, raw)
	}
	snapshot := sourceSnapshotID(t, accepted)
	source["kind"] = "url"
	delete(source, "content")
	source["url"] = "https://127.0.0.1/sub?token=synthetic-secret"
	source["lastErrorCode"] = "constructor"
	status, failed, raw = req(t, owner.c, "PUT", srv.URL+"/api/me/sources/typed-failure", owner.csrf, source)
	if status != 422 {
		t.Fatalf("private address denial: %d %s", status, raw)
	}
	retained = failed["source"].(map[string]any)
	if retained["lastErrorCode"] != "source_address_not_public" || sourceSnapshotID(t, retained) != snapshot || strings.Contains(raw, "synthetic-secret") {
		t.Fatalf("private denial lost snapshot/code redaction: %s", raw)
	}
	status, failed, raw = req(t, owner.c, "POST", srv.URL+"/api/me/sources/typed-failure/refresh", owner.csrf, map[string]any{})
	if status != 422 || failed["source"].(map[string]any)["lastErrorCode"] != "source_address_not_public" {
		t.Fatalf("refresh code: %d %s", status, raw)
	}
	source["enabled"] = false
	source["lastErrorCode"] = "source_fetch_failed"
	status, paused, raw := req(t, owner.c, "PUT", srv.URL+"/api/me/sources/typed-failure", owner.csrf, source)
	if status != 200 || paused["lastErrorCode"] != nil || paused["lastError"] != nil || paused["refreshStatus"] != "paused" || sourceSnapshotID(t, paused) != snapshot {
		t.Fatalf("pause retained forged/stale error: %d %s", status, raw)
	}
	var persisted map[string]any
	if err := s.TenantGet(owner.id, "sources", "typed-failure", &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted["lastErrorCode"] != nil {
		t.Fatal("pause only hid stale code instead of clearing storage")
	}
	source["enabled"] = true
	source["kind"] = "text"
	delete(source, "url")
	source["content"] = "invalid synthetic content"
	status, failed, raw = req(t, owner.c, "PUT", srv.URL+"/api/me/sources/typed-failure", owner.csrf, source)
	if status != 422 || failed["source"].(map[string]any)["lastErrorCode"] != "source_parse_failed" {
		t.Fatalf("parse failure code: %d %s", status, raw)
	}
	source["content"] = "socks5://synthetic.example:1080#Kept\nunsupported://partial-secret@synthetic.example:443"
	status, failed, raw = req(t, owner.c, "PUT", srv.URL+"/api/me/sources/typed-failure", owner.csrf, source)
	if status != 422 || failed["source"].(map[string]any)["lastErrorCode"] != "source_parse_failed" || strings.Contains(raw, "partial-secret") {
		t.Fatalf("invalid partial parse failure code: %d %s", status, raw)
	}
}

func TestSourceFailureCodeProjectionDropsUnknownAndNonfailedCodes(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "failure-code-projection")
	for _, tc := range []struct {
		status, code string
		want         bool
	}{
		{"failed", "source_fetch_failed", true},
		{"failed", "constructor", false},
		{"failed", "https://synthetic.example/?token=private", false},
		{"accepted", "source_fetch_failed", false},
		{"unchanged", "source_fetch_failed", false},
		{"paused", "source_fetch_failed", false},
		{"review-required", "source_fetch_failed", false},
		{"", "source_fetch_failed", false},
	} {
		source := map[string]any{"id": "projection", "name": "Legacy source", "ownerId": owner.id, "kind": "text", "enabled": true, "lastError": "redacted legacy failure", "lastErrorCode": tc.code}
		if tc.status != "" {
			source["refreshStatus"] = tc.status
		}
		if err := s.TenantPut(owner.id, "sources", "projection", source); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"/api/me/sources/projection", "/api/me/sources/projection/reveal"} {
			status, got, raw := req(t, owner.c, "GET", srv.URL+path, "", nil)
			if status != 200 {
				t.Fatal(raw)
			}
			if tc.want && got["lastErrorCode"] != tc.code || !tc.want && got["lastErrorCode"] != nil {
				t.Fatalf("status=%q code=%q path=%s projection %s", tc.status, tc.code, path, raw)
			}
		}
	}
}
