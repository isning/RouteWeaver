package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

// This models a reviewed, persisted deployment from before terminal-capacity
// admission was introduced. New /validate intentionally cannot issue a usable
// fingerprint for this oversized IR; the retained legacy review fingerprint is
// SHA256 of the exact saved IR, not a fallback issued by the new validator.
func TestManagedOversizedLegacyPublicationCanDenyButCannotGrant(t *testing.T) {
	f := newFleetFixture(t)
	var deployment httpapi.ServerDeployment
	if err := f.s.Get("server-deployments", f.in.DeploymentID, &deployment); err != nil {
		t.Fatal(err)
	}
	deployment.IR.Programs = deployment.IR.Programs[:1]
	program := &deployment.IR.Programs[0]
	program.Instance.AdapterID = render.ServerAdapterManagedXray
	program.Instance.Version = render.ManagedXrayVersion
	program.Listener.Connection = domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 22000}
	for i := 0; i < 1000; i++ {
		program.Principals = append(program.Principals, domain.ServerPrincipal{SubjectID: fmt.Sprintf("sub_%043d", i), AccountID: "u_" + strings.Repeat("a", 43), RouteID: "public-route_" + strings.Repeat("b", 16), CredentialVersion: "credential_" + strings.Repeat("c", 16), Credential: domain.PrincipalCredential{UUID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i)}, Action: domain.ActionRef{Kind: "direct"}, PolicyRevision: "topology_" + strings.Repeat("d", 16), CycleID: "cycle_" + strings.Repeat("e", 32)})
	}
	for _, record := range []struct {
		kind, id string
		value    any
	}{{"core-instances", program.Instance.ID, program.Instance}, {"managed-endpoints", program.Listener.ID, program.Listener}} {
		if err := f.s.Put(record.kind, record.id, record.value); err != nil {
			t.Fatal(err)
		}
	}
	f.saveDeployment(t, deployment)
	endpoint := f.srv.URL + "/api/server-deployments/" + deployment.ID
	fingerprint := func(ir domain.ServerDeploymentIR) string {
		raw, err := json.Marshal(ir)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		return hex.EncodeToString(sum[:])
	}
	legacyFingerprint := fingerprint(deployment.IR)
	opened := openServerDraft(t, operatorClient(), endpoint)
	code, validation, raw := validateOpenedServer(t, operatorClient(), endpoint, opened["revisionToken"].(string))
	if code != 200 || validation["valid"] != false || validation["fingerprint"] != nil || !strings.Contains(raw, "MANAGED_TERMINAL_CAPACITY_EXCEEDED") {
		t.Fatalf("new validation issued oversized activation review: %d %s", code, raw)
	}
	publish := func(operation string, allowed bool, review string) map[string]any {
		t.Helper()
		code, result, raw := req(t, operatorClient(), "POST", endpoint+"/publish", "", map[string]any{"operationId": operation, "leaseSeconds": 300, "accessAllowed": allowed, "quotaCertain": true, "expectedFingerprint": review})
		if code != 200 {
			t.Fatalf("publish %d %s", code, raw)
		}
		return result
	}
	refused := publish("oversized-grant", true, legacyFingerprint)
	if refused["status"] != "definitively-rejected" || refused["code"] != "PUBLICATION_REJECTED" {
		t.Fatalf("oversized grant accepted: %+v", refused)
	}
	var desired controlprotocol.Desired
	if err := f.s.Get("agent-desired", program.Instance.ID, &desired); err != store.ErrNotFound {
		t.Fatalf("failed grant mutated desired state: %v", err)
	}
	accepted := publish("oversized-denial", false, legacyFingerprint)
	if accepted["status"] != "publication-accepted" {
		t.Fatalf("legacy denial blocked by activation capacity: %+v", accepted)
	}
	var enrollment httpapi.Enrollment
	if err := f.s.Get("instance-enrollments", program.Instance.ID, &enrollment); err != nil {
		t.Fatal(err)
	}
	received, err := f.transports[program.Instance.ID].ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if err != nil || received == nil {
		t.Fatalf("authenticated denial delivery: %v", err)
	}
	desired = *received
	if desired.Lease.AccessAllowed || !desired.Lease.QuotaCertain || desired.Generation == 0 || desired.Scope != enrollment.Scope {
		t.Fatalf("denial policy/scope lost: %+v", desired.Lease)
	}
	if err = controlprotocol.ValidateDesired(desired, enrollment.Scope); err != nil {
		t.Fatalf("denial artifact integrity invalid: %v", err)
	}
	changed := desired
	changed.Lease.AccessAllowed = true
	if controlprotocol.RequestDigest(changed) == controlprotocol.RequestDigest(desired) {
		t.Fatal("request identity did not bind the denied policy")
	}
	// SHA256 request identity is not a signature. Assert the authenticated desired
	// retains every principal rather than shrinking the deployment to fit a cap.
	found := false
	for _, artifact := range desired.Artifacts {
		if artifact.Path == "entry-policy.json" {
			var descriptor entrypolicy.Descriptor
			if json.Unmarshal([]byte(artifact.Content), &descriptor) != nil || len(descriptor.Bindings) != 1000 {
				t.Fatal("denial truncated legacy principals")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("denial omitted managed binding artifact")
	}
	refused = publish("oversized-regrant", true, legacyFingerprint)
	if refused["status"] != "definitively-rejected" {
		t.Fatalf("regrant bypassed capacity: %+v", refused)
	}
	assertUnchanged := func() {
		t.Helper()
		var after controlprotocol.Desired
		if err := f.s.Get("agent-desired", program.Instance.ID, &after); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(after, desired) {
			t.Fatal("rejected publication mutated the denied desired generation")
		}
	}
	assertUnchanged()
	// Restriction-only rendering skips capacity, not structural/authentication
	// checks. A duplicate native credential must still reject, even when denying.
	program.Principals[1].Credential = program.Principals[0].Credential
	f.saveDeployment(t, deployment)
	invalid := publish("invalid-denial", false, fingerprint(deployment.IR))
	if invalid["status"] != "definitively-rejected" || invalid["code"] != "PUBLICATION_REJECTED" {
		t.Fatalf("structurally invalid denial accepted: %+v", invalid)
	}
	assertUnchanged()
}
