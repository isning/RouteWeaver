package httpapi_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestIndependentOutputReservationIsPrivateIdempotentAndDoesNotPublish(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	path := f.srv.URL + "/api/me/outputs/independent"
	input := map[string]string{"id": "isolated", "name": "phone", "profileId": "rotation-profile"}
	code, _, _ := req(t, f.owner.c, "POST", path, f.owner.csrf, input)
	if code != 422 {
		t.Fatalf("default off: %d", code)
	}
	code, _, raw := req(t, f.admin, "PUT", f.srv.URL+"/api/server-deployments/rotation-path/principal-delegation", "", map[string]any{"enabled": true, "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 4, "maxPendingIntents": 1, "allowRuntimeRestart": true, "expiresAt": time.Now().Add(time.Hour)})
	if code != 200 {
		t.Fatalf("opt in %d %s", code, raw)
	}
	invalid := map[string]any{"id": "invalid-target", "name": "bad", "profileId": "rotation-profile", "target": map[string]string{"adapterId": "unknown", "version": "unknown"}}
	code, _, _ = req(t, f.owner.c, "POST", path, f.owner.csrf, invalid)
	if code != 422 {
		t.Fatalf("unrenderable output reserved: %d", code)
	}
	var missing json.RawMessage
	if err := f.s.TenantGet(f.owner.id, "output-attribution-intents", "invalid-target", &missing); err != store.ErrNotFound {
		t.Fatal("invalid target reserved provisioning work")
	}
	// Exercise the reviewed browser flow, not only the legacy no-review API.
	code, review, raw := req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/preview", f.owner.csrf, input)
	if code != 200 {
		t.Fatalf("preview independent creation %d %s", code, raw)
	}
	input["previewDigest"] = review["previewDigest"].(string)
	changed := map[string]string{"id": input["id"], "name": "changed after review", "profileId": input["profileId"], "previewDigest": input["previewDigest"]}
	code, _, raw = req(t, f.owner.c, "POST", path, f.owner.csrf, changed)
	if code != 422 || !strings.Contains(raw, "review is stale") {
		t.Fatalf("changed reviewed reservation accepted: %d %s", code, raw)
	}
	if err := f.s.TenantGet(f.owner.id, "output-attribution-intents", input["id"], &missing); err != store.ErrNotFound {
		t.Fatal("stale review reserved provisioning work")
	}
	var before json.RawMessage
	f.s.Get("server-deployments", "rotation-path", &before)
	grantsBefore, _ := f.s.TenantList(f.owner.id, "platform-entries")
	code, out, raw := req(t, f.owner.c, "POST", path, f.owner.csrf, input)
	if code != 202 || out["state"] != "reserved" {
		t.Fatalf("reserve %d %s", code, raw)
	}
	for _, secret := range []string{"uuid", "plans", "subjectId", "credential", "token"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("reservation leaks %s", secret)
		}
	}

	code, listed, listRaw := req(t, f.owner.c, "GET", path, "", nil)
	if code != 200 || len(listed["items"].([]any)) != 1 || !strings.Contains(listRaw, "isolated") {
		t.Fatalf("recover reserved intent: %d %s", code, listRaw)
	}
	for _, secret := range []string{"uuid", "plans", "subjectId", "credential", "token"} {
		if strings.Contains(listRaw, secret) {
			t.Fatalf("history leaks %s", secret)
		}
	}
	code, _, foreignRaw := req(t, f.admin, "GET", path, "", nil)
	if code != 200 || strings.Contains(foreignRaw, "isolated") {
		t.Fatalf("history crossed owner boundary: %d %s", code, foreignRaw)
	}
	var after json.RawMessage
	f.s.Get("server-deployments", "rotation-path", &after)
	grantsAfter, _ := f.s.TenantList(f.owner.id, "platform-entries")
	if !reflect.DeepEqual(before, after) || len(grantsBefore) != len(grantsAfter) {
		t.Fatal("reservation changed a deployment or issued a usable credential")
	}
	var output json.RawMessage
	if err := f.s.TenantGet(f.owner.id, "outputs", "isolated", &output); err != store.ErrNotFound {
		t.Fatal("unapplied output published")
	}
	code, _, _ = req(t, f.owner.c, "POST", path, f.owner.csrf, input)
	if code != 200 {
		t.Fatalf("retry %d", code)
	}
	code, _, _ = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs", f.owner.csrf, input)
	if code != 409 {
		t.Fatalf("legacy create stole reservation: %d", code)
	}
	input["id"] = "second"
	code, _, _ = req(t, f.owner.c, "POST", path, f.owner.csrf, input)
	if code != 422 {
		t.Fatalf("pending cap bypass: %d", code)
	}
}
