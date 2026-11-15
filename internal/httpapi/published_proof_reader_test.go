package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

// Entirely synthetic resolver inputs: no server, Store, network or native apply.
type syntheticPublishedReader struct {
	records      map[string]json.RawMessage
	observations []json.RawMessage
	calls        []string
	listError    error
}

func (r *syntheticPublishedReader) Get(kind, id string, out any) error {
	r.calls = append(r.calls, "get:"+kind+":"+id)
	raw, ok := r.records[kind+":"+id]
	if !ok {
		return store.ErrNotFound
	}
	return json.Unmarshal(raw, out)
}
func (r *syntheticPublishedReader) List(kind string) ([]json.RawMessage, error) {
	r.calls = append(r.calls, "list:"+kind)
	if kind != "agent-observations" {
		return nil, fmt.Errorf("unexpected list")
	}
	return r.observations, r.listError
}
func (r *syntheticPublishedReader) put(t *testing.T, kind, id string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	r.records[kind+":"+id] = raw
}
func syntheticPublishedPath(t *testing.T) (*syntheticPublishedReader, time.Time) {
	t.Helper()
	now := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &syntheticPublishedReader{records: map[string]json.RawMessage{}}
	route := domain.PublishedRoute{ID: "route", DeploymentID: "deployment", EndpointIDs: []string{"entry", "exit"}, Path: domain.RoutePath{Entry: "entry", Exit: "exit"}}
	for _, id := range []string{"entry", "exit"} {
		scope := controlprotocol.Scope{NodeID: "node-" + id, InstanceID: id, EnrollmentEpoch: "epoch"}
		identity := controlprotocol.Identity{Scope: scope, AdapterID: "xray", CoreVersion: "fixture", Generation: 1, RevisionID: "rev-" + id, OperationID: "op-" + id, Digest: "synthetic-digest"}
		state := controlprotocol.State{Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true}}
		frozen := domain.DeploymentIdentity{NodeID: scope.NodeID, InstanceID: id, EnrollmentEpoch: "epoch", AdapterID: identity.AdapterID, CoreVersion: identity.CoreVersion, Generation: 1, RevisionID: identity.RevisionID, OperationID: identity.OperationID, Digest: identity.Digest}
		manifest := domain.PublishedManifest{Identity: frozen, DeploymentID: "deployment", Fingerprint: "fingerprint", PolicyExpiresAt: now.Add(time.Nanosecond), Program: domain.ServerProgram{Listener: domain.ManagedEndpoint{ID: id}}, Routes: []domain.PublishedRoute{route}}
		r.put(t, "agent-observations", id, state)
		r.put(t, "published-manifests", identity.RevisionID, manifest)
		r.put(t, "instance-enrollments", id, Enrollment{Scope: scope, ExpiresAt: now.Add(time.Nanosecond)})
		r.observations = append(r.observations, r.records["agent-observations:"+id])
	}
	return r, now
}
func TestPublishedProofUsesOnlyProvidedReaderAndProvidedClock(t *testing.T) {
	r, now := syntheticPublishedPath(t)
	got, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route")
	if err != nil {
		t.Fatal(err)
	}
	if got.Entry.Program.Listener.ID != "entry" || len(got.Programs) != 2 || got.Programs[1].Listener.ID != "exit" {
		t.Fatalf("wrong path: %#v", got)
	}
	want := []string{"list:agent-observations", "get:agent-observations:entry", "get:published-manifests:rev-entry", "get:instance-enrollments:entry", "get:agent-observations:exit", "get:published-manifests:rev-exit", "get:instance-enrollments:exit"}
	if !reflect.DeepEqual(r.calls, want) {
		t.Fatalf("proof read boundary changed: %v", r.calls)
	}
	// Both hops have leases one nanosecond after a historical supplied clock.
	// Equality is expired. The supplied clock is checked separately at each gate.
	if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now.Add(time.Nanosecond) }, "route"); !errors.Is(err, errPublishedProofUnconfirmed) {
		t.Fatalf("lease equality: %v", err)
	}
}

func TestPublishedProofRequiredRecordsFailClosed(t *testing.T) {
	for _, id := range []string{"entry", "exit"} {
		for _, kind := range []string{"agent-observations", "published-manifests", "instance-enrollments"} {
			for _, failure := range []string{"missing", "malformed"} {
				t.Run(id+"/"+kind+"/"+failure, func(t *testing.T) {
					r, now := syntheticPublishedPath(t)
					key := kind + ":" + id
					if kind == "published-manifests" {
						key = kind + ":rev-" + id
					}
					if failure == "missing" {
						delete(r.records, key)
					} else {
						r.records[key] = json.RawMessage(`{`)
					}
					if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route"); err == nil {
						t.Fatal("accepted incomplete required proof")
					}
				})
			}
		}
	}
	r, now := syntheticPublishedPath(t)
	r.listError = errors.New("synthetic list failure")
	if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route"); !errors.Is(err, r.listError) {
		t.Fatalf("list failure: %v", err)
	}
}
func TestPublishedProofRevocationLeasesAndCrossHopIdentity(t *testing.T) {
	for _, id := range []string{"entry", "exit"} {
		for _, mode := range []string{"revoked", "enrollment-equal", "policy-equal", "enrollment-past", "policy-past", "scope", "observed-identity", "deployment", "fingerprint", "route-snapshot", "native-unchecked", "recovering"} {
			t.Run(id+"/"+mode, func(t *testing.T) {
				r, now := syntheticPublishedPath(t)
				var enrollment Enrollment
				var manifest domain.PublishedManifest
				var state controlprotocol.State
				if err := r.Get("instance-enrollments", id, &enrollment); err != nil {
					t.Fatal(err)
				}
				if err := r.Get("published-manifests", "rev-"+id, &manifest); err != nil {
					t.Fatal(err)
				}
				if err := r.Get("agent-observations", id, &state); err != nil {
					t.Fatal(err)
				}
				switch mode {
				case "revoked":
					enrollment.Revoked = true
				case "enrollment-equal":
					enrollment.ExpiresAt = now
				case "policy-equal":
					manifest.PolicyExpiresAt = now
				case "enrollment-past":
					enrollment.ExpiresAt = now.Add(-time.Nanosecond)
				case "policy-past":
					manifest.PolicyExpiresAt = now.Add(-time.Nanosecond)
				case "scope":
					enrollment.Scope.EnrollmentEpoch = "other"
				case "observed-identity":
					manifest.Identity.Digest = "other"
				case "deployment":
					manifest.DeploymentID = "other"
				case "fingerprint":
					manifest.Fingerprint = "other"
				case "route-snapshot":
					manifest.Routes[0].PublicHost = "other.example"
				case "native-unchecked":
					state.NativeChecked = false
				case "recovering":
					state.RecoveryRequired = true
				}
				r.put(t, "instance-enrollments", id, enrollment)
				r.put(t, "published-manifests", "rev-"+id, manifest)
				r.put(t, "agent-observations", id, state)
				if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route"); err == nil {
					t.Fatal("accepted unconfirmed or inconsistent proof")
				}
			})
		}
	}
}
func TestPublishedProofReadsFullInventoryToRejectDuplicateListener(t *testing.T) {
	r, now := syntheticPublishedPath(t)
	var state controlprotocol.State
	var manifest domain.PublishedManifest
	var enrollment Enrollment
	_ = r.Get("agent-observations", "entry", &state)
	_ = r.Get("published-manifests", "rev-entry", &manifest)
	_ = r.Get("instance-enrollments", "entry", &enrollment)
	state.Observed.InstanceID = "duplicate"
	state.Observed.RevisionID = "rev-duplicate"
	manifest.Identity.InstanceID = "duplicate"
	manifest.Identity.RevisionID = "rev-duplicate"
	enrollment.Scope.InstanceID = "duplicate"
	r.put(t, "agent-observations", "duplicate", state)
	r.put(t, "published-manifests", "rev-duplicate", manifest)
	r.put(t, "instance-enrollments", "duplicate", enrollment)
	// The third record is after a complete entry+exit path, so an early success
	// or short-circuited List would incorrectly omit the ambiguous listener.
	r.observations = append(r.observations, r.records["agent-observations:duplicate"])
	if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route"); !errors.Is(err, errPublishedProofUnconfirmed) {
		t.Fatalf("duplicate listener: %v", err)
	}
}

func TestPublishedProofBoundedRechecksExpiryAfterReading(t *testing.T) {
	for failAt := 1; failAt <= 5; failAt++ {
		t.Run(fmt.Sprintf("clock-check-%d", failAt), func(t *testing.T) {
			r, start := syntheticPublishedPath(t)
			calls := 0
			clock := func() time.Time {
				calls++
				if calls >= failAt {
					return start.Add(time.Nanosecond)
				}
				return start
			}
			if _, err := boundedPublishedPathBundle(r, clock, "route"); !errors.Is(err, errPublishedProofUnconfirmed) {
				t.Fatalf("accepted expired proof at check %d: %v", failAt, err)
			}
		})
	}
	// The shared manual resolver preserves its four original checks. The extra
	// final gate is deliberately confined to the new bounded consumer.
	r, start := syntheticPublishedPath(t)
	calls := 0
	clock := func() time.Time {
		calls++
		if calls == 5 {
			return start.Add(time.Nanosecond)
		}
		return start
	}
	if _, err := probeAppliedPublishedPathBundleWithReader(r, clock, "route"); err != nil {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatalf("manual clock checks changed: %d", calls)
	}
}
func TestPublishedProofReturnsEarliestSelectedPathLease(t *testing.T) {
	r, start := syntheticPublishedPath(t)
	for i, id := range []string{"entry", "exit"} {
		var manifest domain.PublishedManifest
		var enrollment Enrollment
		if err := r.Get("published-manifests", "rev-"+id, &manifest); err != nil {
			t.Fatal(err)
		}
		if err := r.Get("instance-enrollments", id, &enrollment); err != nil {
			t.Fatal(err)
		}
		manifest.PolicyExpiresAt = start.Add(time.Duration(30+i*10) * time.Minute)
		enrollment.ExpiresAt = start.Add(time.Duration(20-i*10) * time.Minute)
		r.put(t, "published-manifests", "rev-"+id, manifest)
		r.put(t, "instance-enrollments", id, enrollment)
	}
	got, err := boundedPublishedPathBundle(r, func() time.Time { return start }, "route")
	if err != nil {
		t.Fatal(err)
	}
	if !got.ValidUntil.Equal(start.Add(10 * time.Minute)) {
		t.Fatalf("wrong earliest lease: %s", got.ValidUntil)
	}
	// Now make the entry policy, rather than an enrollment, the earliest fence.
	var manifest domain.PublishedManifest
	if err := r.Get("published-manifests", "rev-entry", &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.PolicyExpiresAt = start.Add(5 * time.Minute)
	r.put(t, "published-manifests", "rev-entry", manifest)
	got, err = boundedPublishedPathBundle(r, func() time.Time { return start }, "route")
	if err != nil {
		t.Fatal(err)
	}
	if !got.ValidUntil.Equal(start.Add(5 * time.Minute)) {
		t.Fatalf("policy fence lost: %s", got.ValidUntil)
	}
}
func TestPublishedProofManualKeepsExistingUnrelatedErrorBehavior(t *testing.T) {
	r, now := syntheticPublishedPath(t)
	r.observations = append([]json.RawMessage{json.RawMessage(`{`)}, r.observations...)
	if _, err := probeAppliedPublishedPathBundleWithReader(r, func() time.Time { return now }, "route"); err != nil {
		t.Fatalf("manual complete path behavior changed: %v", err)
	}
	if _, err := boundedPublishedPathBundle(r, func() time.Time { return now }, "route"); err == nil {
		t.Fatal("bounded proof ignored malformed inventory record")
	}
}
