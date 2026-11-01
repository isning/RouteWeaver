package store_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func providerRouteFixture(t *testing.T) (*store.Store, store.AdmissionScope, time.Time, string, []byte) {
	t.Helper()
	s, path, key, scope, now := admissionFixture(t)
	put := func(kind, id string, v any) {
		t.Helper()
		if err := s.Put(kind, id, v); err != nil {
			t.Fatal(err)
		}
	}
	principal := domain.ServerPrincipal{SubjectID: "subject", AccountID: "account", RouteID: "route", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000001"}}
	route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", PublicHost: "entry.example.invalid", PublicPort: 443, Path: domain.RoutePath{ID: "path", Entry: "entry1", Exit: "transit"}, EndpointIDs: []string{"entry1", "transit"}}
	for _, h := range []struct{ node, instance, entry string }{{scope.NodeID, scope.InstanceID, "entry1"}, {"transit-node", "transit-instance", "transit"}, {"unrelated-node", "unrelated-instance", "unrelated"}} {
		instance := domain.CoreInstance{ID: h.instance, HostID: h.node, AdapterID: "routeweaver/managed-xray", Version: "fixture"}
		endpoint := domain.ManagedEndpoint{ID: h.entry, InstanceID: h.instance, Authentication: "principals", Connection: domain.Connection{Host: "127.0.0.1", Port: 443, Protocol: "vless", TLS: &domain.TLSOptions{Enabled: true, ServerName: "entry.example.invalid"}}}
		identity := domain.DeploymentIdentity{NodeID: h.node, InstanceID: h.instance, EnrollmentEpoch: scope.EnrollmentEpoch, AdapterID: instance.AdapterID, CoreVersion: instance.Version, Generation: 1, RevisionID: "revision-" + h.instance, OperationID: "operation-" + h.instance, Digest: "digest"}
		manifest := domain.PublishedManifest{PolicyExpiresAt: now.Add(time.Hour), DeploymentID: "deployment", Fingerprint: "fingerprint", Identity: identity, Program: domain.ServerProgram{Instance: instance, Listener: endpoint, Principals: []domain.ServerPrincipal{principal}}, Routes: []domain.PublishedRoute{route}}
		put("hosts", h.node, domain.Host{ID: h.node, Name: h.node})
		put("core-instances", h.instance, instance)
		put("managed-endpoints", h.entry, endpoint)
		put("instance-enrollments", h.instance, map[string]any{"scope": store.AdmissionScope{NodeID: h.node, InstanceID: h.instance, EnrollmentEpoch: scope.EnrollmentEpoch}, "expiresAt": now.Add(time.Hour), "revoked": false})
		put("published-manifests", identity.RevisionID, manifest)
		put("agent-observations", h.instance, map[string]any{"phase": "observed_conformant", "nativeChecked": true, "observed": map[string]any{"nodeId": h.node, "instanceId": h.instance, "enrollmentEpoch": scope.EnrollmentEpoch, "adapterId": instance.AdapterID, "coreVersion": instance.Version, "generation": "1", "revisionId": identity.RevisionID, "operationId": identity.OperationID, "digest": identity.Digest, "known": true, "quiescent": true}})
		if h.entry == "entry1" {
			connection, err := domain.PublicPrincipalConnection(route, endpoint, principal)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.TenantPut("account", "platform-entries", "entry1", map[string]any{"id": "entry1", "userId": "account", "routeId": "route", "credentialVersion": "v1", "publishedRouteId": "route", "subjectId": "subject", "deploymentId": "deployment", "connection": connection}); err != nil {
				t.Fatal(err)
			}
		}
	}
	return s, scope, now, path, key
}
func suspensionConfig(now time.Time) observability.Config {
	return observability.Config{BilledInterfaces: []string{}, Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "suspend-managed"}}
}
func TestProviderSuspensionFollowsExactAppliedHopsAndKeepsSettlement(t *testing.T) {
	s, scope, now, _, _ := providerRouteFixture(t)
	req := admissionRequest("entry1", "192.0.2.1", "provider-presence")
	check := func(at time.Time, want string) store.AdmissionDecision {
		t.Helper()
		d, e := s.AcquireAdmission(scope, req, at)
		if e != nil || d.Allowed != (want == "") || d.Reason != want {
			t.Fatalf("admit reason want=%q got=%+v err=%v", want, d, e)
		}
		return d
	}
	check(now, "")
	if _, err := s.ConfigureNodeObservations("unrelated-node", suspensionConfig(now)); err != nil {
		t.Fatal(err)
	}
	check(now.Add(time.Second), "") // An unrelated exhausted/unknown host cannot stop this route.
	if _, err := s.ConfigureNodeObservations("transit-node", suspensionConfig(now)); err != nil {
		t.Fatal(err)
	}
	check(now.Add(2*time.Second), "provider-usage-unknown")
	statement := observability.StatementInput{CycleID: "cycle", UsedBytes: 1000000000, ObservedAt: now.Add(2 * time.Second), Reference: "synthetic operator statement"}
	if _, err := s.RecordNodeProviderStatement("transit-node", statement, "operator", now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	check(now.Add(3*time.Second), "provider-exhausted")
	statement.UsedBytes = 10
	statement.ObservedAt = now.Add(4 * time.Second)
	if _, err := s.RecordNodeProviderStatement("transit-node", statement, "operator", now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	check(now.Add(5*time.Second), "")
	check(now.Add(16*time.Minute), "provider-usage-unknown")
	req.Final = true
	check(now.Add(16*time.Minute+time.Millisecond), "presence-closed")
	req.Final = false
	req.PresenceID = "provider-recovered-presence"
	state, err := s.NodeObservations("transit-node")
	if err != nil {
		t.Fatal(err)
	}
	state.Config.Provider.ExhaustionAction = "advisory"
	if _, err = s.ConfigureNodeObservations("transit-node", state.Config); err != nil {
		t.Fatal(err)
	}
	check(now.Add(16*time.Minute+time.Second), "")
	// Final closure must remain accepted even after suspension: never strand evidence.
	state, err = s.NodeObservations("transit-node")
	if err != nil {
		t.Fatal(err)
	}
	state.Config.Provider.ExhaustionAction = "suspend-managed"
	if _, err = s.ConfigureNodeObservations("transit-node", state.Config); err != nil {
		t.Fatal(err)
	}
	req.Final = true
	check(now.Add(16*time.Minute+2*time.Second), "presence-closed")
}

func TestProviderSuspensionSerializesAcrossHandlesAndRejectsUnsupportedHost(t *testing.T) {
	s, scope, now, path, key := providerRouteFixture(t)
	other, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	config := suspensionConfig(now)
	config.Provider.ExhaustionAction = "advisory"
	state, err := s.ConfigureNodeObservations("transit-node", config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RecordNodeProviderStatement("transit-node", observability.StatementInput{CycleID: "cycle", UsedBytes: 1000000000, ObservedAt: now, Reference: "synthetic"}, "operator", now); err != nil {
		t.Fatal(err)
	}
	state.Config.Provider.ExhaustionAction = "suspend-managed"
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	var saveErr, admitErr error
	go func() {
		defer wg.Done()
		<-start
		_, saveErr = s.ConfigureNodeObservations("transit-node", state.Config)
	}()
	go func() {
		defer wg.Done()
		<-start
		_, admitErr = other.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "concurrent-policy"), now)
	}()
	close(start)
	wg.Wait()
	if saveErr != nil || admitErr != nil {
		t.Fatal(saveErr, admitErr)
	}
	after, err := other.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "concurrent-policy"), now.Add(time.Second))
	if err != nil || after.Allowed || after.Reason != "provider-exhausted" {
		t.Fatalf("stale admission after committed policy: %+v %v", after, err)
	}
	if err = s.Put("hosts", "stock-only", domain.Host{ID: "stock-only", Name: "Stock"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("core-instances", "stock", domain.CoreInstance{ID: "stock", HostID: "stock-only", AdapterID: "xray"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ConfigureNodeObservations("stock-only", suspensionConfig(now)); err == nil {
		t.Fatal("claimed managed enforcement on stock-only host")
	}
	unchanged, err := s.NodeObservations("stock-only")
	if err != nil || unchanged.Config.Provider != nil {
		t.Fatal("failed capability check changed settings", err)
	}
}
