package httpapi

import (
	"encoding/json"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func QueuePrincipalMigrationForTest(t *testing.T, s *store.Store, owner string, apply ...func(string)) {
	t.Helper()
	token := "012345678901234567890123456789012345"
	h := &server{s: s, opts: Options{AdminToken: token}}
	var before ServerDeployment
	if err := s.Get("server-deployments", "rotation-path", &before); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(before)
	var candidate ServerDeployment
	json.Unmarshal(raw, &candidate)
	old := candidate.IR.Programs[0].Principals[0]
	fresh := old
	fresh.SubjectID = "new-output-subject"
	fresh.CredentialVersion = "new-output-v1"
	fresh.Credential = domain.PrincipalCredential{UUID: "22222222-2222-4222-8222-222222222222"}
	candidate.IR.Programs[0].Principals = append(candidate.IR.Programs[0].Principals, fresh)
	var route domain.PublishedRoute
	s.Get("published-routes", fresh.RouteID, &route)
	conn, err := domain.PublicPrincipalConnection(route, candidate.IR.Programs[0].Listener, fresh)
	if err != nil {
		t.Fatal(err)
	}
	grant := PublicEntryGrant{ID: "new-output-grant", UserID: owner, RouteID: route.ID, PublishedRouteID: route.ID, SubjectID: fresh.SubjectID, DeploymentID: before.ID, CredentialVersion: fresh.CredentialVersion, Connection: conn, OutputID: "new-output", OutputRevision: "output-v1"}
	if err = s.TenantPut(owner, "output-attribution-intents", "new-output", map[string]string{"revision": "output-v1", "state": "reserved"}); err != nil {
		t.Fatal(err)
	}
	cap := principalDelegation{ID: before.ID, Revision: "cap-v1", Enabled: true, IssuerAccountID: "operator", IssuerAuthorityDigest: auth.Digest(token), DeploymentID: before.ID, InstanceIDs: deploymentInstanceIDs(before.IR), AllowedRouteIDs: []string{route.ID}, MaxPrincipalsPerUser: 10, MaxPendingIntents: 3, AllowRuntimeRestart: true, BaseNonPrincipalFingerprint: principalIndependentFingerprint(before.IR), ExpiresAt: time.Now().Add(time.Hour)}
	s.Put("principal-delegations", before.ID, cap)
	if len(apply) > 0 {
		apply[0]("baseline")
	}
	for _, program := range before.IR.Programs {
		id := program.Instance.ID
		var d controlprotocol.Desired
		s.Get("agent-desired", id, &d)
		var intent serviceIntent
		s.Get("agent-service-intents", id, &intent)
		intent.Status = "running"
		s.Put("agent-service-intents", id, intent)
		state := controlprotocol.State{Desired: func() *controlprotocol.Identity { v := d.Identity(); return &v }(), Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: d.Identity(), Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}}
		if len(apply) == 0 {
			s.Put("agent-observations", id, state)
		}
	}
	writes := []store.RecordWrite{{Kind: store.TenantKind(owner, "platform-entries"), ID: grant.ID, Value: grant}}
	p, err := h.preparePrincipalServiceMigration("migration-test", owner, "new-output", "output-v1", "cap-v1", candidate, writes)
	if err != nil {
		t.Fatal(err)
	}
	binding := store.EntryAdmissionBinding{ID: fresh.SubjectID, InstanceID: candidate.IR.Programs[0].Instance.ID, EntryID: candidate.IR.Programs[0].Listener.ID, SubjectID: fresh.SubjectID, UserID: owner, RouteID: route.ID, GrantID: grant.ID, CredentialVersion: fresh.CredentialVersion, OutputID: "new-output", OutputRevision: "output-v1"}
	cap.Enabled = false
	s.Put("principal-delegations", before.ID, cap)
	if err = h.queuePrincipalServiceMigration(p, []store.EntryAdmissionBinding{binding}, nil, nil); err == nil {
		t.Fatal("stale delegated permission committed")
	}
	var absent PublicEntryGrant
	if err = s.TenantGet(owner, "platform-entries", grant.ID, &absent); err != store.ErrNotFound {
		t.Fatal("failed migration leaked grant")
	}
	for _, id := range p.TargetIDs {
		var d controlprotocol.Desired
		s.Get("agent-desired", id, &d)
		if d.Identity() != p.Receipt.OldDesired[id].Identity() {
			t.Fatal("failed CAS consumed desired generation")
		}
	}
	cap.Enabled = true
	s.Put("principal-delegations", before.ID, cap)
	if err = h.queuePrincipalServiceMigration(p, []store.EntryAdmissionBinding{binding}, nil, []store.RecordWrite{{Kind: store.TenantKind(owner, "output-attribution-intents"), ID: "new-output", Value: map[string]string{"revision": "output-v1", "state": "provisioning"}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.preparePrincipalServiceMigration("other-migration", owner, "other-output", "other-v1", "cap-v1", candidate, writes); err == nil || !strings.Contains(err.Error(), "unfinished subscription") {
		t.Fatalf("competing output did not respect durable provisioning lock: %v", err)
	}
	for _, id := range p.TargetIDs {
		var d controlprotocol.Desired
		var intent serviceIntent
		s.Get("agent-desired", id, &d)
		s.Get("agent-service-intents", id, &intent)
		if !intent.Running || intent.ActorID != "operator" || intent.MigrationID != "migration-test" || intent.Current != d.Identity() {
			t.Fatal("service authority was not atomically migrated")
		}
		if err = h.checkServiceAuthority(&preparedFleet{}, intent); err != nil {
			t.Fatal(err)
		}
	}
	after, err := h.prepareFleet(p.Batch.Batch.Input)
	if err != nil {
		t.Fatal(err)
	}
	if after.ContinuousAuthorityHash != p.Batch.ContinuousAuthorityHash {
		t.Fatal("postcommit authority hash differs from prepared overlay")
	}
	if len(apply) > 0 {
		if err = s.TenantPut(owner, "output-attribution-intents", "new-output", map[string]string{"revision": "output-v1", "state": "published"}); err != nil {
			t.Fatal(err)
		}
		apply[0]("migrated")
	}
	// Revoking future self-service permission does not prevent exact cleanup.
	cap.Enabled = false
	s.Put("principal-delegations", before.ID, cap)
	for _, id := range p.TargetIDs {
		var d controlprotocol.Desired
		s.Get("agent-desired", id, &d)
		var intent serviceIntent
		s.Get("agent-service-intents", id, &intent)
		intent.Status = "running"
		s.Put("agent-service-intents", id, intent)
		identity := d.Identity()
		if len(apply) == 0 {
			s.Put("agent-observations", id, controlprotocol.State{Desired: &identity, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}})
		}
	}
	// Model the final publication transaction releasing its provisioning lock.
	var publishedLock principalProvisioningLock
	s.Get("principal-provisioning-locks", before.ID, &publishedLock)
	if err = s.CompareSetsAndRemoveRecord("principal-provisioning-locks", before.ID, []store.RecordCompare{{Kind: "principal-provisioning-locks", ID: before.ID, Expected: publishedLock}}, nil); err != nil {
		t.Fatal(err)
	}
	compensation, err := h.preparePrincipalServiceCompensation(owner, "migration-test")
	if err != nil {
		t.Fatal(err)
	}
	if err = h.queuePrincipalServiceCompensation(compensation, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(apply) > 0 {
		apply[0]("compensated")
	}
	var reverted ServerDeployment
	s.Get("server-deployments", before.ID, &reverted)
	if serverFingerprint(reverted.IR) != serverFingerprint(before.IR) {
		t.Fatal("compensation did not preserve original deployment principals")
	}
	for _, id := range p.TargetIDs {
		var d controlprotocol.Desired
		s.Get("agent-desired", id, &d)
		if d.Generation <= p.Receipt.OldDesired[id].Generation+1 {
			t.Fatal("compensation reused a generation")
		}
		var intent serviceIntent
		s.Get("agent-service-intents", id, &intent)
		if !intent.Running {
			t.Fatal("compensation disabled continuous service")
		}
		if err = h.checkServiceAuthority(&preparedFleet{}, intent); err != nil {
			t.Fatal(err)
		}
	}

}

// Compare actual nil-overlay preparation against the pre-migration digest
// projection (path reads never belonged to authorization Compares).
func AssertLegacyMigrationAuthorityForTest(t *testing.T, s *store.Store) {
	t.Helper()
	h := &server{s: s}
	p, err := h.prepareFleet(fleet.Input{Action: "configure", DeploymentID: "rotation-path", TargetIDs: []string{"rotation-core", "rotation-transit"}})
	if err != nil {
		t.Fatal(err)
	}
	legacy := p
	legacy.Compares = nil
	legacy.Sets = nil
	legacy.Policies = map[string]service.EffectivePolicy{}
	if err := h.legacyRefreshFleetPrincipals68cbef5(&legacy); err != nil {
		t.Fatal(err)
	}
	hash, err := continuousAuthorityFingerprint(legacy.Compares, legacy.Policies)
	if err != nil {
		t.Fatal(err)
	}
	if hash != p.ContinuousAuthorityHash || fleet.Fingerprint(legacy.Compares) != p.AuthorizationHash {
		t.Fatal("nil-overlay preparation changed legacy continuous authority digest")
	}
	// Reproduce the unsafe mixed-proof projection from 9a6aeee: this fixture
	// must distinguish it from the historical digest rather than pass vacuously.
	unsafe := p
	unsafe.Compares = nil
	unsafe.Sets = nil
	unsafe.Policies = map[string]service.EffectivePolicy{}
	if err := h.refreshFleetPrincipals(&unsafe, &unsafe); err != nil {
		t.Fatal(err)
	}
	unsafeHash, err := continuousAuthorityFingerprint(unsafe.Compares, unsafe.Policies)
	if err != nil {
		t.Fatal(err)
	}
	if unsafeHash == hash {
		t.Fatal("fixture did not reproduce the old-service hash regression")
	}
	// Collect the same path reads separately and ensure they remain CAS-fenced.
	isolated := p
	isolated.Compares = nil
	isolated.Sets = nil
	deps := preparedFleet{}
	if err := h.refreshFleetPrincipals(&isolated, &deps); err != nil {
		t.Fatal(err)
	}
	if len(deps.Compares) == 0 {
		t.Fatal("legacy compatibility fixture must exercise wildcard path reads")
	}
	for _, want := range deps.Compares {
		found := false
		for _, got := range p.Compares {
			if got.Kind == want.Kind && got.ID == want.ID {
				found = true
			}
		}
		if !found {
			t.Fatalf("lost path dependency CAS: %s/%s", want.Kind, want.ID)
		}
	}
}

func SetLegacyWildcardMigrationFixtureForTest(t *testing.T, s *store.Store) {
	var d ServerDeployment
	if err := s.Get("server-deployments", "rotation-path", &d); err != nil {
		t.Fatal(err)
	}
	d.IR.Programs[1].Listener.Connection.Host = "0.0.0.0"
	if err := s.Put("managed-endpoints", d.IR.Programs[1].Listener.ID, d.IR.Programs[1].Listener); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("server-deployments", d.ID, d); err != nil {
		t.Fatal(err)
	}
}
func PersistLegacyMigrationAuthorityForTest(t *testing.T, s *store.Store) {
	h := &server{s: s}
	p, err := h.prepareFleet(fleet.Input{Action: "configure", DeploymentID: "rotation-path", TargetIDs: []string{"rotation-core", "rotation-transit"}})
	if err != nil {
		t.Fatal(err)
	}
	p.Compares = nil
	p.Sets = nil
	p.Policies = map[string]service.EffectivePolicy{}
	if err := h.legacyRefreshFleetPrincipals68cbef5(&p); err != nil {
		t.Fatal(err)
	}
	hash, err := continuousAuthorityFingerprint(p.Compares, p.Policies)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"rotation-core", "rotation-transit"} {
		var intent serviceIntent
		if err := s.Get("agent-service-intents", id, &intent); err != nil {
			t.Fatal(err)
		}
		var batch fleetRecord
		if err := s.Get("fleet-batches", intent.BatchID, &batch); err != nil {
			t.Fatal(err)
		}
		batch.ContinuousAuthorityHash = hash
		if err := s.Put("fleet-batches", intent.BatchID, batch); err != nil {
			t.Fatal(err)
		}
	}
}
