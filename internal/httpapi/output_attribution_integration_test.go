package httpapi_test

import (
	"routeweaver/internal/httpapi"
	"testing"
	"time"
)

// Explicit synthetic applied observations; native process validation is separate.
func TestIndependentOutputsProvisionPublishAndSettleSeparately(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	input := map[string]any{"action": "configure", "deploymentId": "rotation-path", "targetIds": []string{"rotation-core", "rotation-transit"}, "continuousService": true}
	plan := f.postAdmin("admin/fleet-batches/preview", input)
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 300
	batch := f.postAdmin("admin/fleet-batches", input)
	f.postAdmin("admin/fleet-batches/"+batch["id"].(string)+"/execute", map[string]any{"stage": 0, "requestId": "attribution-baseline"})
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	code, _, raw := req(t, f.admin, "PUT", f.srv.URL+"/api/server-deployments/rotation-path/principal-delegation", "", map[string]any{"enabled": true, "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 8, "maxPendingIntents": 2, "allowRuntimeRestart": true, "expiresAt": time.Now().Add(time.Hour)})
	if code != 200 {
		t.Fatalf("enable %d %s", code, raw)
	}
	for i, id := range []string{"first-output", "second-output"} {
		code, _, raw = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/independent", f.owner.csrf, map[string]string{"id": id, "name": id, "profileId": "rotation-profile"})
		if code != 202 {
			t.Fatalf("reserve %d %s", code, raw)
		}
		if i > 0 {
			httpapi.AdvancePastAttributionCooldownForTest(t, f.s, f.owner.id, id)
		}
		if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, id); state != "provisioning" {
			t.Fatal(state)
		}
		httpapi.ObserveAttributionServicesForTest(t, f.s)
		if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, id); state != "published" {
			t.Fatal(state)
		}
		f.ownerRequest("GET", "/me/outputs/"+id+"/access", nil, 200)
		httpapi.SettleAttributedBytesForTest(t, f.s, f.owner.id, id, uint64((i+1)*23))
	}
	code, _, raw = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/independent/first-output/cancel", f.owner.csrf, nil)
	if code != 202 {
		t.Fatalf("cancel %d %s", code, raw)
	}
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "first-output"); state != "cancelling" {
		t.Fatal(state)
	}
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "first-output"); state != "cancelled" {
		t.Fatal(state)
	}
	f.ownerRequest("GET", "/me/outputs/second-output/access", nil, 200)
	f.ownerRequest("GET", "/me/outputs/first-output/access", nil, 404)

}

func TestIndependentOutputRevocationBeforePublicationCancelsAndRecovers(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	input := map[string]any{"action": "configure", "deploymentId": "rotation-path", "targetIds": []string{"rotation-core", "rotation-transit"}, "continuousService": true}
	plan := f.postAdmin("admin/fleet-batches/preview", input)
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 300
	batch := f.postAdmin("admin/fleet-batches", input)
	f.postAdmin("admin/fleet-batches/"+batch["id"].(string)+"/execute", map[string]any{"stage": 0, "requestId": "revocation-baseline"})
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	capURL := f.srv.URL + "/api/server-deployments/rotation-path/principal-delegation"
	code, cap, raw := req(t, f.admin, "PUT", capURL, "", map[string]any{"enabled": true, "allowedRouteIds": []string{"rotation-line"}, "maxPrincipalsPerUser": 8, "maxPendingIntents": 2, "allowRuntimeRestart": true, "expiresAt": time.Now().Add(time.Hour)})
	if code != 200 {
		t.Fatalf("enable %d %s", code, raw)
	}
	code, _, raw = req(t, f.owner.c, "POST", f.srv.URL+"/api/me/outputs/independent", f.owner.csrf, map[string]string{"id": "cancel-before-publish", "name": "phone", "profileId": "rotation-profile"})
	if code != 202 {
		t.Fatalf("reserve %d %s", code, raw)
	}
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "cancel-before-publish"); state != "provisioning" {
		t.Fatal(state)
	}
	code, _, raw = req(t, f.admin, "PUT", capURL, "", map[string]any{"enabled": false, "expectedRevision": cap["revision"]})
	if code != 200 {
		t.Fatalf("disable %d %s", code, raw)
	}
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "cancel-before-publish"); state != "cancelling" {
		t.Fatal(state)
	}
	f.ownerRequest("GET", "/me/outputs/cancel-before-publish/access", nil, 404)
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "cancel-before-publish"); state != "cancelling" {
		t.Fatal(state)
	}
	httpapi.RecordAttributionCleanupRetryForTest(t, f.s, f.owner.id, "cancel-before-publish")
	httpapi.ObserveAttributionServicesForTest(t, f.s)
	if state := httpapi.AdvanceAttributedOutputForTest(t, f.s, f.owner.id, "cancel-before-publish"); state != "cancelled" {
		t.Fatal(state)
	}
	entries, err := f.s.ListOutputAttributionQueue("", 100)
	if err != nil || len(entries) != 0 {
		t.Fatalf("cleanup recovery queue leaked: %v %v", entries, err)
	}
}
