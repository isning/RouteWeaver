package store

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"strings"
	"testing"
	"time"
)

func quotaSourceFixture(t *testing.T) (*Store, time.Time, domain.DeploymentIdentity) {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Now().UTC()
	instance := domain.CoreInstance{ID: "core", HostID: "node", AdapterID: "routeweaver/managed-xray", Version: "26.3.27-rw1"}
	endpoint := domain.ManagedEndpoint{ID: "entry", InstanceID: "core", Authentication: "principals", Connection: domain.Connection{Host: "127.0.0.1", Port: 443, Protocol: "vless", TLS: &domain.TLSOptions{Enabled: true, ServerName: "entry.example.invalid"}}}
	principal := domain.ServerPrincipal{SubjectID: "subject", AccountID: "account", RouteID: "route", CredentialVersion: "v1", PolicyRevision: "policy", CycleID: "cycle", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000001"}}
	route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", PublicHost: "entry.example.invalid", PublicPort: 443, Path: domain.RoutePath{ID: "path", Entry: "entry", Exit: "entry"}, EndpointIDs: []string{"entry"}}
	conn, e := domain.PublicPrincipalConnection(route, endpoint, principal)
	if e != nil {
		t.Fatal(e)
	}
	identity := domain.DeploymentIdentity{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch", AdapterID: instance.AdapterID, CoreVersion: instance.Version, Generation: 1, RevisionID: "revision", OperationID: "operation", Digest: strings.Repeat("a", 64)}
	m := domain.PublishedManifest{PolicyExpiresAt: now.Add(time.Hour), DeploymentID: "deployment", Fingerprint: strings.Repeat("b", 64), Identity: identity, Program: domain.ServerProgram{Instance: instance, Listener: endpoint, Principals: []domain.ServerPrincipal{principal}}, Routes: []domain.PublishedRoute{route}}
	observed := map[string]any{}
	raw, _ := json.Marshal(identity)
	json.Unmarshal(raw, &observed)
	observed["known"] = true
	observed["quiescent"] = true
	binding := EntryAdmissionBinding{ID: "entry", InstanceID: "core", EntryID: "entry", SubjectID: "subject", UserID: "account", RouteID: "route", GrantID: "entry", CredentialVersion: "v1"}
	meter := MeterBinding{ID: "meter", InstanceID: "core", SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
	put := func(k, id string, v any) {
		t.Helper()
		if e := s.Put(k, id, v); e != nil {
			t.Fatal(e)
		}
	}
	put("core-instances", "core", instance)
	put("managed-endpoints", "entry", endpoint)
	put("agent-desired", "core", identity)
	put("published-manifests", "revision", m)
	put("agent-observations", "core", map[string]any{"phase": "observed_conformant", "nativeChecked": true, "observed": observed})
	put("instance-enrollments", "core", map[string]any{"scope": domain.InstanceScope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, "expiresAt": now.Add(time.Hour)})
	put("entry-admission-bindings", admissionBindingKey("core", "entry", "subject", "v1"), binding)
	put("meter-bindings", bindingKey(meter), meter)
	put(TenantKind("account", "platform-entries"), "entry", admissionGrant{ID: "entry", UserID: "account", RouteID: "route", CredentialVersion: "v1", PublishedRouteID: "route", SubjectID: "subject", DeploymentID: "deployment", Connection: conn})
	return s, now, identity
}
func quotaRead(t *testing.T, s *Store, now time.Time) quotaSourceProof {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	p, e := s.quotaSourcesTx(tx, "account", now)
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func TestQuotaSourcesCurrentManagedProofAndOwnerIsolation(t *testing.T) {
	s, now, _ := quotaSourceFixture(t)
	proof := quotaRead(t, s, now)
	if !proof.Available || len(proof.RouteIDs) != 1 || proof.RouteIDs[0] != "route" {
		t.Fatalf("proof %+v", proof)
	}
	// An ordinary source belonging to another account must not disqualify this owner.
	other := MeterBinding{ID: "other", InstanceID: "other-core", SubjectID: "other-subject", UserID: "other", RouteID: "other-route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: "entry_payload"}
	s.Put("meter-bindings", bindingKey(other), other)
	proof = quotaRead(t, s, now)
	if !proof.Available {
		t.Fatal(proof)
	}
	for _, d := range proof.Dependencies {
		if strings.Contains(d.ID, "other") {
			t.Fatal("foreign dependency", d)
		}
	}
}
func TestQuotaSourcesRejectIncompleteLegacyAndUnapplied(t *testing.T) {
	for _, tc := range []string{"ordinary", "missing-meter", "wrong-desired", "revoked-enrollment", "expired", "missing-hop", "unbound-grant", "unknown-attribution", "stop-desired"} {
		t.Run(tc, func(t *testing.T) {
			s, now, id := quotaSourceFixture(t)
			switch tc {
			case "ordinary":
				b := MeterBinding{ID: "old", InstanceID: "old-core", SubjectID: "old-subject", UserID: "account", RouteID: "old-route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: "entry_payload"}
				s.Put("meter-bindings", bindingKey(b), b)
			case "missing-meter":
				s.Remove("meter-bindings", "core:subject:route:policy:cycle:"+entrypolicy.MeasurementLayer)
			case "stop-desired":
				b, _ := json.Marshal(id)
				var v map[string]any
				json.Unmarshal(b, &v)
				v["action"] = "stop"
				s.Put("agent-desired", "core", v)
			case "wrong-desired":
				id.Generation++
				s.Put("agent-desired", "core", id)
			case "revoked-enrollment":
				s.Put("instance-enrollments", "core", map[string]any{"revoked": true})
			case "expired":
				now = now.Add(2 * time.Hour)
			case "missing-hop":
				var m domain.PublishedManifest
				s.Get("published-manifests", "revision", &m)
				m.Routes[0].EndpointIDs = append(m.Routes[0].EndpointIDs, "missing")
				s.Put("published-manifests", "revision", m)
			case "unbound-grant":
				s.TenantPut("account", "platform-entries", "orphan", admissionGrant{ID: "orphan", UserID: "account"})
			case "unknown-attribution":
				var b EntryAdmissionBinding
				s.Get("entry-admission-bindings", "core:entry:subject:v1", &b)
				b.OutputID = "output"
				b.OutputRevision = "rev"
				s.Put("entry-admission-bindings", "core:entry:subject:v1", b)
			}
			if p := quotaRead(t, s, now); p.Available || len(p.Dependencies) != 0 {
				t.Fatalf("unsafe proof %s %+v", tc, p)
			}
		})
	}
}
func TestQuotaSourcesOversizedInventoryFailsClosed(t *testing.T) {
	s, now, _ := quotaSourceFixture(t)
	s.Put("meter-bindings", "oversized", map[string]any{"padding": strings.Repeat("x", quotaSourceRecordBytes)})
	if p := quotaRead(t, s, now); p.Available || p.Reason != "source_inventory_limit" {
		t.Fatal(p)
	}
}

func TestQuotaSourcesRetireOnlyExplicitlyDeniedManagedBindings(t *testing.T) {
	for _, mode := range []string{"revoked", "replaced-version"} {
		t.Run(mode, func(t *testing.T) {
			s, now, _ := quotaSourceFixture(t)
			if e := s.PutUser(domain.User{ID: "account", Name: "Synthetic", Enabled: true}); e != nil {
				t.Fatal(e)
			}
			old := EntryAdmissionBinding{ID: "old-entry", InstanceID: "core", EntryID: "entry", SubjectID: "old-subject", UserID: "account", RouteID: "route", GrantID: "old-entry", CredentialVersion: "old"}
			if mode == "replaced-version" {
				old.GrantID = "entry"
				old.SubjectID = "subject"
			}
			meter := MeterBinding{ID: "old-meter", InstanceID: "core", SubjectID: old.SubjectID, UserID: "account", RouteID: "route", PolicyRevision: "old-policy", CycleID: "old-cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
			record, e := EntryAdmissionBindingRecord(old)
			if e != nil {
				t.Fatal(e)
			}
			if e = s.Put(record.Kind, record.ID, record.Value); e != nil {
				t.Fatal(e)
			}
			if e := s.SetMeterBinding(meter); e != nil {
				t.Fatal(e)
			}
			if mode == "revoked" {
				s.Put(TenantKind("account", "platform-entries"), "old-entry", admissionGrant{ID: "old-entry", UserID: "account", Revoked: true})
			}
			if got := quotaRead(t, s, now); !got.Available {
				t.Fatalf("explicit denial remained an immortal unknown source %+v", got)
			}
			meter.LedgerMode = "counter"
			meter.MeasurementLayer = "entry_payload"
			if e := s.SetMeterBinding(meter); e != nil {
				t.Fatal(e)
			}
			if got := quotaRead(t, s, now); got.Available || got.Reason != "ordinary_counter_source" {
				t.Fatalf("guessed ordinary source retirement %+v", got)
			}
		})
	}
}

func TestQuotaSourcesSubjectMismatchAloneDoesNotRetireNonManagedSource(t *testing.T) {
	s, now, _ := quotaSourceFixture(t)
	if e := s.PutUser(domain.User{ID: "account", Name: "Synthetic", Enabled: true}); e != nil {
		t.Fatal(e)
	}
	old := EntryAdmissionBinding{ID: "old", InstanceID: "stock", EntryID: "old-entry", SubjectID: "old-subject", UserID: "account", RouteID: "route", GrantID: "entry", CredentialVersion: "v1"}
	record, e := EntryAdmissionBindingRecord(old)
	if e != nil {
		t.Fatal(e)
	}
	s.Put(record.Kind, record.ID, record.Value)
	s.Put("core-instances", "stock", domain.CoreInstance{ID: "stock", AdapterID: "xray"})
	meter := MeterBinding{ID: "old-meter", InstanceID: "stock", SubjectID: "old-subject", UserID: "account", RouteID: "route", PolicyRevision: "old-policy", CycleID: "old-cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
	if e = s.SetMeterBinding(meter); e != nil {
		t.Fatal(e)
	}
	if got := quotaRead(t, s, now); got.Available {
		t.Fatal("subject mismatch was treated as unconditional admission denial")
	}
}
