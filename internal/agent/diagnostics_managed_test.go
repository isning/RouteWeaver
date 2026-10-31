package agent

import (
	"context"
	"os"
	"path/filepath"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"strings"
	"testing"
	"time"
)

type diagnosticFenceAdapter struct{ observed Observation }

func (a *diagnosticFenceAdapter) Descriptor() Descriptor {
	return Descriptor{ID: ManagedXrayID, Version: ManagedXrayVersion, CanActivate: true, NativeValidation: true}
}
func (a *diagnosticFenceAdapter) Validate(context.Context, Staged) error { return nil }
func (a *diagnosticFenceAdapter) Activate(context.Context, Staged) error { return nil }
func (a *diagnosticFenceAdapter) Observe(context.Context, string) (Observation, error) {
	return a.observed, nil
}
func managedFenceFixture(t *testing.T) (*Reconciler, *diagnosticFenceAdapter, diagnostics.Job, *AdmissionBroker) {
	t.Helper()
	root := t.TempDir()
	os.Chmod(root, 0700)
	d := testDesired(t, 1)
	d.AdapterID = ManagedXrayID
	d.CoreVersion = ManagedXrayVersion
	a := &diagnosticFenceAdapter{Observation{Identity: d.Identity(), Known: true, Quiescent: true}}
	stage, e := stageFiles(root, d)
	if e != nil {
		t.Fatal(e)
	}
	if e = switchStage(root, stage); e != nil {
		t.Fatal(e)
	}
	r := &Reconciler{root: root, registry: NewRegistry(a), options: Options{Now: time.Now, MaxLease: 2 * time.Hour}, disk: journal{Scope: d.Scope, Payload: &d, LastValid: &d, State: State{Phase: ObservedConformant, NativeChecked: true}}}
	b, e := StartAdmissionBroker(root, diagnosticFenceAuthority{})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { b.Close() })
	pipes, e := prepareManagedPipes(Staged{Root: root, Desired: d})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(pipes.OnExit)
	now := time.Now().UTC()
	j, e := diagnostics.NewJob(diagnostics.Request{ID: "probe", TargetID: "target", InstanceID: d.InstanceID, Kind: "connectivity", TimeoutSeconds: 1, PathMode: "managed_route", PublishedRouteID: "route"}, diagnostics.Target{ID: "target", Name: "Public target", NodeID: d.NodeID, URL: "https://example.com/", Methods: []string{"connectivity"}}, d.Scope, "admin", now)
	if e != nil {
		t.Fatal(e)
	}
	identity := domain.DeploymentIdentity{NodeID: d.NodeID, InstanceID: d.InstanceID, EnrollmentEpoch: d.EnrollmentEpoch, AdapterID: d.AdapterID, CoreVersion: d.CoreVersion, Generation: d.Generation, RevisionID: d.RevisionID, OperationID: d.OperationID, Digest: d.Digest}
	j.ManagedPath = &diagnostics.ManagedPath{RouteID: "route", DeploymentID: "deployment", Fingerprint: strings.Repeat("a", 64), EntryEndpointID: "entry", ExitEndpointID: "entry", ConnectorID: "rw-direct", Hops: []diagnostics.PathHop{{EndpointID: "entry", Identity: identity}}}
	j.Status = "running"
	j.AttemptID = "attempt"
	j.ClaimedAt = &now
	return r, a, j, b
}
func TestManagedDiagnosticFenceRequiresExactEffectiveProcessArtifactsAndPolicy(t *testing.T) {
	for _, mode := range []string{"current", "inactive-install", "recovery", "observed-different", "unknown", "nonquiescent", "artifact-drift", "expired", "pipe-different", "last-valid-different"} {
		t.Run(mode, func(t *testing.T) {
			r, a, j, b := managedFenceFixture(t)
			switch mode {
			case "inactive-install":
				candidate := *r.disk.Payload
				candidate.AdapterID = "routeweaver/sing-box"
				candidate.Action = "install"
				candidate.Generation++
				r.disk.Payload = &candidate
			case "recovery":
				r.disk.State.RecoveryRequired = true
			case "observed-different":
				a.observed.Generation++
			case "unknown":
				a.observed.Known = false
			case "nonquiescent":
				a.observed.Quiescent = false
			case "artifact-drift":
				os.WriteFile(filepath.Join(r.root, "current", "config.json"), []byte("different bytes"), 0600)
			case "expired":
				policy := r.disk.LastValid.Lease
				policy.ExpiresAt = time.Now().Add(-time.Second)
				r.disk.LatestPolicy = &policy
			case "pipe-different":
				b.session.identity.Generation++
			case "last-valid-different":
				d := *r.disk.LastValid
				d.Generation++
				r.disk.LastValid = &d
			}
			client, e := r.diagnosticControl(context.Background(), j)
			if mode == "current" || mode == "inactive-install" {
				if e != nil || client == nil {
					t.Fatalf("valid effective runtime rejected: %v", e)
				}
			} else if e == nil {
				t.Fatal("unsafe or stale runtime received RPC authority")
			}
		})
	}
}

type diagnosticFenceAuthority struct{}

func (diagnosticFenceAuthority) Acquire(context.Context, entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{}, nil
}
func (diagnosticFenceAuthority) Release(context.Context, string) error { return nil }
