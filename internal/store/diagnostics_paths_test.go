package store_test

import (
	"errors"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func diagnosticPathFixture(t *testing.T, s *store.Store, now time.Time) []domain.PublishedManifest {
	t.Helper()
	route := domain.PublishedRoute{ID: "route", Name: "FRA through UK", DeploymentID: "deployment", Path: domain.RoutePath{Entry: "fra-entry", Exit: "uk-exit"}, EndpointIDs: []string{"fra-entry", "uk-exit"}}
	out := []domain.PublishedManifest{}
	for i, id := range []string{"one", "two"} {
		endpoint := route.EndpointIDs[i]
		identity := domain.DeploymentIdentity{NodeID: "node", InstanceID: id, EnrollmentEpoch: "epoch", AdapterID: "routeweaver/managed-xray", CoreVersion: "26.3.27-rw1", Generation: 1, RevisionID: "revision-" + id, OperationID: "operation-" + id, Digest: strings.Repeat("a", 64)}
		program := domain.ServerProgram{Instance: domain.CoreInstance{ID: id, HostID: "node", AdapterID: identity.AdapterID}, Listener: domain.ManagedEndpoint{ID: endpoint, InstanceID: id}}
		if i == 0 {
			program.Principals = []domain.ServerPrincipal{{SubjectID: "subject", RouteID: "route", Action: domain.ActionRef{Kind: "forward", Ref: "through-uk"}, Credential: domain.PrincipalCredential{UUID: "private-test-principal-not-returned"}}}
			program.Connectors = []domain.ServerConnector{{ID: "through-uk", Connection: domain.Connection{Password: "private-transit-not-returned"}}}
		}
		m := domain.PublishedManifest{PolicyExpiresAt: now.Add(time.Hour), DeploymentID: "deployment", Fingerprint: strings.Repeat("b", 64), Identity: identity, Program: program, Routes: []domain.PublishedRoute{route}}
		diagnosticSaveManifest(t, s, m, now)
		out = append(out, m)
	}
	return out
}
func diagnosticSaveManifest(t *testing.T, s *store.Store, m domain.PublishedManifest, now time.Time) {
	t.Helper()
	i := m.Identity
	observation := controlprotocol.Observation{Identity: controlprotocol.Identity{Scope: controlprotocol.Scope{NodeID: i.NodeID, InstanceID: i.InstanceID, EnrollmentEpoch: i.EnrollmentEpoch}, AdapterID: i.AdapterID, CoreVersion: i.CoreVersion, Generation: i.Generation, RevisionID: i.RevisionID, OperationID: i.OperationID, Digest: i.Digest}, Known: true, Quiescent: true, ObservedAt: now}
	if e := s.Put("published-manifests", i.RevisionID, m); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("agent-observations", i.InstanceID, controlprotocol.State{Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &observation}); e != nil {
		t.Fatal(e)
	}
}
func managedRequest(id string) diagnostics.Request {
	return diagnostics.Request{ID: id, TargetID: "target", InstanceID: "one", Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2, PathMode: "managed_route", PublishedRouteID: "route"}
}
func TestManagedDiagnosticPinsEveryAppliedHopAndRejectsUnknownOrAmbiguousPath(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	manifests := diagnosticPathFixture(t, s, now)
	paths, e := s.DiagnosticPaths(now)
	if e != nil || len(paths) != 1 || len(paths[0].ManagedPath.Hops) != 2 {
		t.Fatalf("paths=%+v error=%v", paths, e)
	}
	j, e := s.RequestDiagnostic(managedRequest("managed"), "operator", now)
	if e != nil || j.Validate(j.Scope) != nil || j.ManagedPath.ConnectorID != "through-uk" {
		t.Fatalf("job=%+v error=%v", j, e)
	}
	// The job remains pinned even if mutable published-route draft changes.
	if e = s.Put("published-routes", "route", domain.PublishedRoute{ID: "route", Name: "unapplied-draft"}); e != nil {
		t.Fatal(e)
	}
	replay, e := s.RequestDiagnostic(managedRequest("managed"), "operator", now)
	if e != nil || diagnostics.Digest(replay) != diagnostics.Digest(j) {
		t.Fatal("idempotent immutable request changed")
	}
	wrong := managedRequest("wrong-instance")
	wrong.InstanceID = "two"
	if _, e = s.RequestDiagnostic(wrong, "operator", now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("non-entry instance %v", e)
	}
	wrong = managedRequest("wrong-route")
	wrong.PublishedRouteID = "unknown"
	if _, e = s.RequestDiagnostic(wrong, "operator", now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("unknown route %v", e)
	}
	// A changed exit identity prevents dispatch, although the entry is unchanged.
	exit := manifests[1]
	exit.Identity.Generation++
	exit.Identity.RevisionID = "revision-two-new"
	diagnosticSaveManifest(t, s, exit, now)
	claimed, e := s.ClaimDiagnostic(j.Scope, "attempt", now)
	if e != nil || claimed != nil {
		t.Fatalf("stale hop dispatched %+v %v", claimed, e)
	}
	stopped, e := s.DiagnosticJob(j.ID, now)
	if e != nil || stopped.Status != "not_run" || stopped.Result.Code != "path_changed" || !stopped.Result.CostKnown {
		t.Fatalf("stale queue=%+v %v", stopped, e)
	}
	// An ambiguous principal action is not guessed from a loose/default rule.
	entry := manifests[0]
	entry.Program.Principals = append(entry.Program.Principals, domain.ServerPrincipal{RouteID: "route", Action: domain.ActionRef{Kind: "direct"}})
	diagnosticSaveManifest(t, s, entry, now)
	paths, e = s.DiagnosticPaths(now)
	if e != nil || len(paths) != 0 {
		t.Fatal("ambiguous route was offered")
	}
}
func TestManagedDiagnosticChangedHopCannotReportSuccessAndExactReplayRemainsIdempotent(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	manifests := diagnosticPathFixture(t, s, now)
	j, e := s.RequestDiagnostic(managedRequest("managed-report"), "operator", now)
	if e != nil {
		t.Fatal(e)
	}
	claimed, e := s.ClaimDiagnostic(j.Scope, "attempt", now)
	if e != nil || claimed == nil {
		t.Fatal(e)
	}
	exit := manifests[1]
	exit.Identity.Generation++
	exit.Identity.RevisionID = "exit-replaced"
	diagnosticSaveManifest(t, s, exit, now)
	pending, e := s.DiagnosticJob(j.ID, now)
	if e != nil || pending.Status != "unknown" || pending.Result.Code != "path_changed" || pending.Result.CostKnown {
		t.Fatalf("running changed path=%+v %v", pending, e)
	}
	rate := 4096.0
	report := diagnostics.Report{JobID: j.ID, Scope: j.Scope, AttemptID: "attempt", Result: diagnostics.Result{Status: "succeeded", Phase: "complete", Code: "completed", StartedAt: now, FinishedAt: now.Add(time.Second), DurationMS: 1000, BytesReceived: 4096, CostKnown: true, BytesPerSecond: &rate, HTTPStatus: 200}}
	if e = s.AcceptDiagnosticReport(report, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	final, e := s.DiagnosticJob(j.ID, now.Add(time.Second))
	if e != nil || final.Status != "failed" || final.Result.Code != "path_changed" || final.Result.BytesReceived != 4096 || final.Result.BytesPerSecond != nil {
		t.Fatalf("stale success not downgraded %+v %v", final, e)
	}
	if e = s.AcceptDiagnosticReport(report, now.Add(2*time.Second)); e != nil {
		t.Fatalf("lost receipt exact replay %v", e)
	}
	report.Result.BytesReceived = 0
	report.Result.Status = "failed"
	report.Result.BytesPerSecond = nil
	if e = s.AcceptDiagnosticReport(report, now.Add(2*time.Second)); !errors.Is(e, store.ErrConflict) {
		t.Fatalf("changed report replay %v", e)
	}
}
func TestManagedDiagnosticRequiresFreshAllHopObservationEnrollmentAndLease(t *testing.T) {
	for _, mode := range []string{"old-observation", "expired-policy", "old-epoch", "unobserved", "wrong-fingerprint"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, now := diagnosticStoreFixture(t)
			manifests := diagnosticPathFixture(t, s, now)
			exit := manifests[1]
			switch mode {
			case "old-observation":
				diagnosticSaveManifest(t, s, exit, now.Add(-2*time.Minute))
			case "expired-policy":
				exit.PolicyExpiresAt = now
				diagnosticSaveManifest(t, s, exit, now)
			case "old-epoch":
				exit.Identity.EnrollmentEpoch = "old-epoch"
				diagnosticSaveManifest(t, s, exit, now)
			case "unobserved":
				s.Put("agent-observations", "two", controlprotocol.State{Phase: controlprotocol.AppliedUnobserved})
			case "wrong-fingerprint":
				exit.Fingerprint = strings.Repeat("c", 64)
				diagnosticSaveManifest(t, s, exit, now)
			}
			if _, e := s.RequestDiagnostic(managedRequest("denied"), "operator", now); !errors.Is(e, diagnostics.ErrScope) {
				t.Fatalf("unsafe path accepted: %v", e)
			}
		})
	}
}

func TestDiagnosticUnknownOutcomeRetainsPhysicalNodeLaneUntilBoundedStopHorizon(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	first := diagnosticStoreRequest(t, s, "uncertain-first", "one", now)
	claimed, e := s.ClaimDiagnostic(first.Scope, "first-attempt", now)
	if e != nil || claimed == nil {
		t.Fatal(e)
	}
	second := diagnosticStoreRequest(t, s, "next-other-instance", "two", now)
	report := diagnostics.Report{JobID: first.ID, Scope: first.Scope, AttemptID: claimed.AttemptID, Result: diagnostics.Result{Status: "unknown", Phase: "path", Code: "managed_probe_outcome_unknown", StartedAt: now, FinishedAt: now, CostKnown: false}}
	if e = s.AcceptDiagnosticReport(report, now); e != nil {
		t.Fatal(e)
	}
	next, e := s.ClaimDiagnostic(second.Scope, "next-attempt", now.Add(time.Second))
	if e != nil || next != nil {
		t.Fatalf("unknown stop allowed overlapping node traffic: %+v %v", next, e)
	}
	next, e = s.ClaimDiagnostic(second.Scope, "next-attempt", now.Add(18*time.Second))
	if e != nil || next == nil || next.ID != second.ID {
		t.Fatalf("node lane not released after hard deadline: %+v %v", next, e)
	}
}
func TestManagedDiagnosticChangedPathPreservesNotRunAndUnknownEvidence(t *testing.T) {
	for _, status := range []string{"not_run", "unknown"} {
		t.Run(status, func(t *testing.T) {
			s, _, _, now := diagnosticStoreFixture(t)
			manifests := diagnosticPathFixture(t, s, now)
			j, e := s.RequestDiagnostic(managedRequest("changed-evidence"), "operator", now)
			if e != nil {
				t.Fatal(e)
			}
			claimed, e := s.ClaimDiagnostic(j.Scope, "attempt", now)
			if e != nil || claimed == nil {
				t.Fatal(e)
			}
			exit := manifests[1]
			exit.Identity.RevisionID = "exit-new"
			exit.Identity.Generation++
			diagnosticSaveManifest(t, s, exit, now)
			report := diagnostics.Report{JobID: j.ID, Scope: j.Scope, AttemptID: claimed.AttemptID, Result: diagnostics.Result{Status: status, Phase: "path", Code: "runtime-unavailable", StartedAt: now, FinishedAt: now, CostKnown: status == "not_run"}}
			if e = s.AcceptDiagnosticReport(report, now); e != nil {
				t.Fatal(e)
			}
			final, e := s.DiagnosticJob(j.ID, now)
			if e != nil || final.Status != status || final.Result.CostKnown != (status == "not_run") {
				t.Fatalf("path invalidation fabricated execution certainty %+v %v", final, e)
			}
		})
	}
}

func TestManagedDiagnosticRejectsMixedPathProjection(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	manifests := diagnosticPathFixture(t, s, now)
	for _, manifest := range manifests {
		manifest.Routes[0].Hops = []domain.PublishedRouteHop{
			{Kind: "managed", EndpointID: "fra-entry"},
			{Kind: "connector", ConnectorID: "external"},
			{Kind: "managed", EndpointID: "uk-exit"},
		}
		diagnosticSaveManifest(t, s, manifest, now)
	}
	paths, err := s.DiagnosticPaths(now)
	if err != nil || len(paths) != 0 {
		t.Fatalf("mixed path exposed as a managed-only probe: %+v %v", paths, err)
	}
	if _, err = s.RequestDiagnostic(managedRequest("mixed"), "operator", now); !errors.Is(err, diagnostics.ErrScope) {
		t.Fatalf("partial mixed-path diagnostic accepted: %v", err)
	}
}
