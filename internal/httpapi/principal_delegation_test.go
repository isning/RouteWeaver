package httpapi_test

import (
	"strings"
	"testing"
	"time"
)

func TestPrincipalDelegationRequiresExplicitBoundedAdminOptIn(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	url := f.srv.URL + "/api/server-deployments/rotation-path/principal-delegation"
	code, out, raw := req(t, f.admin, "GET", url, "", nil)
	if code != 200 || out["enabled"] != false {
		t.Fatalf("default must be off: %d %s", code, raw)
	}
	body := map[string]any{"enabled": true, "expectedRevision": "", "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 4, "maxPendingIntents": 1, "expiresAt": time.Now().Add(time.Hour)}
	code, _, _ = req(t, f.owner.c, "PUT", url, f.owner.csrf, body)
	if code != 403 {
		t.Fatalf("tenant granted infrastructure authority: %d", code)
	}
	code, _, _ = req(t, f.admin, "PUT", url, "", body)
	if code != 400 {
		t.Fatalf("missing restart acknowledgement: %d", code)
	}
	body["allowRuntimeRestart"] = true
	code, out, raw = req(t, f.admin, "PUT", url, "", body)
	if code != 200 || out["enabled"] != true || strings.Contains(raw, "issuerAuthorityDigest") {
		t.Fatalf("bounded opt-in: %d %s", code, raw)
	}
	revision := out["revision"].(string)
	code, _, _ = req(t, f.admin, "PUT", url, "", body)
	if code != 409 {
		t.Fatalf("stale config replay: %d", code)
	}
	code, out, raw = req(t, f.admin, "PUT", url, "", map[string]any{"enabled": false, "expectedRevision": revision})
	if code != 200 || out["enabled"] != false {
		t.Fatalf("revoke: %d %s", code, raw)
	}
	f.ownerRequest("POST", "/me/outputs", map[string]string{"id": "legacy", "name": "legacy", "profileId": "rotation-profile"}, 201)
	f.ownerRequest("GET", "/me/outputs/legacy/access", nil, 200)
}
