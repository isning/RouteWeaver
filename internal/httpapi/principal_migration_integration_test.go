package httpapi_test

import (
	"routeweaver/internal/httpapi"
	"testing"
)

func TestPrincipalMigrationAtomicOverlay(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	httpapi.SetLegacyWildcardMigrationFixtureForTest(t, f.s)
	input := map[string]any{"action": "configure", "deploymentId": "rotation-path", "targetIds": []string{"rotation-core", "rotation-transit"}, "continuousService": true}
	plan := f.postAdmin("admin/fleet-batches/preview", input)
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 300
	batch := f.postAdmin("admin/fleet-batches", input)
	f.postAdmin("admin/fleet-batches/"+batch["id"].(string)+"/execute", map[string]any{"stage": 0, "requestId": "migration-baseline"})
	httpapi.AssertLegacyMigrationAuthorityForTest(t, f.s)
	httpapi.QueuePrincipalMigrationForTest(t, f.s, f.owner.id)
}
