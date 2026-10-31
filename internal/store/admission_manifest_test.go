package store_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestManagedAdmissionRequiresCurrentAppliedImmutableManifest(t *testing.T) {
	for _, bad := range []string{"none", "missing", "expired-policy", "wrong-credential", "changed-generation", "revoked-enrollment"} {
		t.Run(bad, func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			instance := domain.CoreInstance{ID: scope.InstanceID, HostID: scope.NodeID, AdapterID: "routeweaver/managed-xray", Version: "fixture"}
			endpoint := domain.ManagedEndpoint{ID: "entry1", InstanceID: instance.ID, Authentication: "principals", Connection: domain.Connection{Host: "127.0.0.1", Port: 443, Protocol: "vless", TLS: &domain.TLSOptions{Enabled: true, ServerName: "entry.example.invalid"}}}
			principal := domain.ServerPrincipal{SubjectID: "subject", AccountID: "account", RouteID: "route", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000001"}}
			route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", PublicHost: "entry.example.invalid", PublicPort: 443, Path: domain.RoutePath{ID: "path", Entry: "entry1", Exit: "entry1"}, EndpointIDs: []string{"entry1"}}
			connection, e := domain.PublicPrincipalConnection(route, endpoint, principal)
			if e != nil {
				t.Fatal(e)
			}
			identity := domain.DeploymentIdentity{NodeID: scope.NodeID, InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, AdapterID: instance.AdapterID, CoreVersion: instance.Version, Generation: 1, RevisionID: "revision", OperationID: "operation", Digest: "digest"}
			manifest := domain.PublishedManifest{PolicyExpiresAt: now.Add(5 * time.Second), DeploymentID: "deployment", Fingerprint: "fingerprint", Identity: identity, Program: domain.ServerProgram{Instance: instance, Listener: endpoint, Principals: []domain.ServerPrincipal{principal}}, Routes: []domain.PublishedRoute{route}}
			put := func(kind, id string, v any) {
				t.Helper()
				if e := s.Put(kind, id, v); e != nil {
					t.Fatal(e)
				}
			}
			put("core-instances", instance.ID, instance)
			put("managed-endpoints", endpoint.ID, endpoint)
			grant := map[string]any{"id": "entry1", "userId": "account", "routeId": "route", "credentialVersion": "v1", "publishedRouteId": "route", "subjectId": "subject", "deploymentId": "deployment", "connection": connection}
			if e = s.TenantPut("account", "platform-entries", "entry1", grant); e != nil {
				t.Fatal(e)
			}
			if bad == "expired-policy" {
				manifest.PolicyExpiresAt = now
			}
			if bad == "wrong-credential" {
				manifest.Program.Principals[0].Credential.UUID = "00000000-0000-4000-8000-000000000002"
			}
			if bad != "missing" {
				put("published-manifests", "revision", manifest)
			}
			observed := map[string]any{"nodeId": identity.NodeID, "instanceId": identity.InstanceID, "enrollmentEpoch": identity.EnrollmentEpoch, "adapterId": identity.AdapterID, "coreVersion": identity.CoreVersion, "generation": "1", "revisionId": identity.RevisionID, "operationId": identity.OperationID, "digest": identity.Digest, "known": true, "quiescent": true}
			if bad == "changed-generation" {
				observed["generation"] = "2"
			}
			put("agent-observations", instance.ID, map[string]any{"phase": "observed_conformant", "nativeChecked": true, "observed": observed})
			if bad == "revoked-enrollment" {
				put("instance-enrollments", instance.ID, map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour), "revoked": true})
			}
			decision, e := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "manifest-presence"), now)
			if e != nil {
				t.Fatal(e)
			}
			if bad == "none" && decision.ExpiresAt.After(now.Add(5*time.Second)) {
				t.Fatal("entry lease outlives immutable deployed policy")
			}
			if decision.Allowed != (bad == "none") {
				t.Fatalf("manifest gate %s: %+v", bad, decision)
			}
		})
	}
}
func TestManagedBindingCannotUseLegacyGrantBypass(t *testing.T) {
	s, _, _, scope, _ := admissionFixture(t)
	if e := s.Put("core-instances", scope.InstanceID, domain.CoreInstance{ID: scope.InstanceID, AdapterID: "routeweaver/managed-xray"}); e != nil {
		t.Fatal(e)
	}
	e := s.SetEntryAdmissionBinding(store.EntryAdmissionBinding{ID: "legacy-bypass", InstanceID: scope.InstanceID, EntryID: "entry1", SubjectID: "other-subject", UserID: "account", RouteID: "route", GrantID: "entry1", CredentialVersion: "v1"})
	if e == nil {
		t.Fatal("legacy configured grant admitted as managed native principal")
	}
}
