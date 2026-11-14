package httpapi_test

import (
	"encoding/json"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestPlatformCreationRequiresVerifiedIndependentMetering(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	input := map[string]string{"id": "new-device", "name": "device", "profileId": "rotation-profile"}
	preview := func(available bool, reason string) {
		t.Helper()
		code, out, raw := req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/preview", f.owner.csrf, input)
		if code != 200 {
			t.Fatalf("preview %d %s", code, raw)
		}
		eligibility, ok := out["independentMetering"].(map[string]any)
		if !ok || eligibility["required"] != true || eligibility["available"] != available {
			t.Fatalf("eligibility %v", eligibility)
		}
		if reason != "" && eligibility["reason"] != reason {
			t.Fatalf("reason %v", eligibility)
		}
		for _, kind := range []string{"outputs", "output-attribution-intents"} {
			var value json.RawMessage
			if err := f.s.TenantGet(f.owner.id, kind, input["id"], &value); err != store.ErrNotFound {
				t.Fatalf("preview persisted %s: %v", kind, err)
			}
		}
	}
	preview(false, "authorization_required")
	code, _, _ := req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs", f.owner.csrf, input)
	if code != 422 {
		t.Fatalf("ordinary pure platform bypass %d", code)
	}
	code, _, raw := req(t, f.admin, "PUT", f.srv.URL+"/api/server-deployments/rotation-path/principal-delegation", "", map[string]any{"enabled": true, "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 4, "maxPendingIntents": 1, "allowRuntimeRestart": true, "expiresAt": time.Now().Add(time.Hour)})
	if code != 200 {
		t.Fatalf("enable %d %s", code, raw)
	}
	preview(true, "")
	code, _, _ = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs", f.owner.csrf, input)
	if code != 422 {
		t.Fatalf("enabled ordinary bypass %d", code)
	}
	code, _, raw = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/independent", f.owner.csrf, input)
	if code != 202 {
		t.Fatalf("real reservation %d %s", code, raw)
	}
}
