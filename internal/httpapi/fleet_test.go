package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

type fleetFixture struct {
	databasePath string
	s            *store.Store
	srv          *httptest.Server
	in           fleet.Input
	transports   map[string]*agent.HTTPTransport
}

func newFleetFixture(t *testing.T) fleetFixture {
	t.Helper()
	databasePath := filepath.Join(t.TempDir(), "db")
	s, srv := makeServerAt(t, databasePath)
	f := fleetFixtureAt(t, s, srv)
	f.databasePath = databasePath
	return f
}
func fleetFixtureAt(t *testing.T, s *store.Store, srv *httptest.Server) fleetFixture {
	t.Helper()
	f := fleetFixture{s: s, srv: srv, in: fleet.Input{Action: "configure", DeploymentID: "fleet-deployment", TargetIDs: []string{"fleet-a", "fleet-b"}, Stages: [][]string{{"fleet-a"}, {"fleet-b"}}}, transports: map[string]*agent.HTTPTransport{}}
	deployment := httpapi.ServerDeployment{ID: f.in.DeploymentID, Name: "Fleet", IR: domain.ServerDeploymentIR{ID: f.in.DeploymentID, SchemaVersion: "1.0", TopologyRevision: "topology1"}}
	for i, id := range f.in.TargetIDs {
		host := domain.Host{ID: "host-" + id, Name: id, Address: "127.0.0.1"}
		instance := domain.CoreInstance{ID: id, Name: id, HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}
		endpoint := domain.ManagedEndpoint{ID: "entry-" + id, InstanceID: id, Name: id, Connection: domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: 22000 + i, Username: "fixture-user", Password: "fixture-password"}}
		for _, v := range []struct {
			path  string
			value any
		}{{"hosts", host}, {"core-instances", instance}, {"managed-endpoints", endpoint}} {
			f.post(t, v.path, v.value, 200)
		}
		enrollment := f.post(t, "agent/enrollments", map[string]any{"nodeId": host.ID, "instanceId": id, "expiresAt": time.Now().Add(time.Hour)}, 201)
		var scope agent.Scope
		raw, _ := json.Marshal(enrollment["scope"])
		json.Unmarshal(raw, &scope)
		tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrollment["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(tr.Close)
		f.transports[id] = tr
		deployment.IR.Programs = append(deployment.IR.Programs, domain.ServerProgram{Instance: instance, Listener: endpoint})
	}
	f.saveDeployment(t, deployment)
	return f
}
func (f fleetFixture) post(t *testing.T, path string, body any, want int) map[string]any {
	t.Helper()
	code, out, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/"+path, "", body)
	if code != want {
		t.Fatalf("POST %s = %d want %d: %s", path, code, want, raw)
	}
	return out
}
func (f fleetFixture) create(t *testing.T) string {
	t.Helper()
	plan := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["expectedFingerprint"] = plan["fingerprint"]
	in["leaseSeconds"] = 300
	return f.post(t, "admin/fleet-batches", in, 201)["id"].(string)
}
func (f fleetFixture) job(t *testing.T, id string) fleet.Batch {
	t.Helper()
	code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/admin/fleet-batches/"+id, "", nil)
	if code != 200 {
		t.Fatal(code, raw)
	}
	var job fleet.Batch
	if e := json.Unmarshal([]byte(raw), &job); e != nil {
		t.Fatal(e)
	}
	return job
}
func (f fleetFixture) observe(t *testing.T, id, phase string) controlprotocol.Desired {
	t.Helper()
	tr := f.transports[id]
	d, e := tr.ReceiveDesired(context.Background(), func() agent.Scope { var e httpapi.Enrollment; f.s.Get("instance-enrollments", id, &e); return e.Scope }(), 0)
	if e != nil || d == nil {
		t.Fatalf("desired: %v %v", d, e)
	}
	identity := d.Identity()
	state := controlprotocol.State{Desired: &identity, HighestAccepted: d.Generation, Phase: phase, NativeChecked: true}
	if phase == controlprotocol.ObservedConformant {
		state.Observed = &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now()}
	} else {
		state.Code = "synthetic_validation_failure"
	}
	if e = tr.ReportObservation(context.Background(), d.Scope, state); e != nil {
		t.Fatal(e)
	}
	return *d
}

func TestFleetPhasesKeepSuccessAndRetryOnlyFailedTargets(t *testing.T) {
	f := newFleetFixture(t)
	id := f.create(t)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 1, "requestId": "too-early"}, 409)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "stage-zero"}, 200)
	if job := f.job(t, id); job.Status == "succeeded" || job.Targets[0].Status != "queued" {
		t.Fatalf("unobserved queue claimed success: %+v", job)
	}
	first := f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 1, "requestId": "stage-one"}, 200)
	failed := f.observe(t, "fleet-b", controlprotocol.ValidationFailed)
	job := f.job(t, id)
	if job.Status != "partial_failure" {
		t.Fatalf("partial failure hidden: %+v", job)
	}
	f.post(t, "admin/fleet-batches/"+id+"/retry", map[string]any{"targetIds": []string{"fleet-a"}, "requestId": "bad-retry"}, 409)
	retry := map[string]any{"targetIds": []string{"fleet-b"}, "requestId": "retry-one"}
	f.post(t, "admin/fleet-batches/"+id+"/retry", retry, 200)
	f.post(t, "admin/fleet-batches/"+id+"/retry", retry, 200)
	second := f.observe(t, "fleet-b", controlprotocol.ObservedConformant)
	if second.Generation != failed.Generation+1 {
		t.Fatal("idempotent retry duplicated generation")
	}
	job = f.job(t, id)
	if job.Status != "succeeded" || len(job.Targets[0].Attempts) != 1 || job.Targets[0].Attempts[0].Identity.Generation != first.Generation || len(job.Targets[1].Attempts) != 2 {
		t.Fatalf("retry damaged results: %+v", job)
	}
	var manifest domain.PublishedManifest
	if e := f.s.Get("published-manifests", second.RevisionID, &manifest); e != nil || manifest.Identity.Generation != second.Generation {
		t.Fatal("atomic publication manifest absent", e)
	}
}

func TestFleetStalePreviewConcurrentExecutionAndAuthorization(t *testing.T) {
	f := newFleetFixture(t)
	plan := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	var deployment httpapi.ServerDeployment
	if e := f.s.Get("server-deployments", f.in.DeploymentID, &deployment); e != nil {
		t.Fatal(e)
	}
	deployment.IR.TopologyRevision = "topology2"
	f.saveDeployment(t, deployment)
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["expectedFingerprint"] = plan["fingerprint"]
	in["leaseSeconds"] = 300
	f.post(t, "admin/fleet-batches", in, 409)
	id := f.create(t)
	// Different operation identifiers cannot both publish the same reviewed target.
	results := make(chan int, 2)
	for _, key := range []string{"parallel-one", "parallel-two"} {
		go func(key string) {
			code, _, _ := req(t, operatorClient(), "POST", f.srv.URL+"/api/admin/fleet-batches/"+id+"/execute", "", map[string]any{"stage": 0, "requestId": key})
			results <- code
		}(key)
	}
	a, b := <-results, <-results
	if !(a == 200 && b == 409 || a == 409 && b == 200) {
		t.Fatalf("concurrent execute: %d %d", a, b)
	}
	var desired controlprotocol.Desired
	if e := f.s.Get("agent-desired", "fleet-a", &desired); e != nil || desired.Generation != 1 {
		t.Fatal("concurrent plans duplicated desired generation", e)
	}
	user := inviteClient(t, f.s, f.srv, "fleet-user")
	if code, _, _ := req(t, user.c, "GET", f.srv.URL+"/api/admin/fleet-batches", "", nil); code != 403 {
		t.Fatal("tenant read fleet history", code)
	}
	if code, _, _ := req(t, user.c, "POST", f.srv.URL+"/api/admin/fleet-batches/preview", user.csrf, f.in); code != 403 {
		t.Fatal("tenant planned fleet operations", code)
	}
	if code, _, _ := req(t, http.DefaultClient, "GET", f.srv.URL+"/api/admin/fleet-batches", "", nil); code != 401 {
		t.Fatal("anonymous fleet history", code)
	}
	f.in.Action = "upgrade"
	f.in.TargetReleaseID = "xray-26.10.31-linux-amd64"
	unsupported := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	if unsupported["supported"] != false {
		t.Fatal("upgrade was falsely supported")
	}
}
func TestFleetPartialEnrollmentFailureRetainsInputAndSuccessHistory(t *testing.T) {
	f := newFleetFixture(t)
	f.in.Stages = nil
	id := f.create(t)
	var enrollment httpapi.Enrollment
	if e := f.s.Get("instance-enrollments", "fleet-b", &enrollment); e != nil {
		t.Fatal(e)
	}
	enrollment.Revoked = true
	f.s.Put("instance-enrollments", "fleet-b", enrollment)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "partial"}, 200)
	first := f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	job := f.job(t, id)
	if job.Status != "partial_failure" || job.Targets[1].Attempts[0].Code != "enrollment_changed" {
		t.Fatalf("enrollment failure hidden: %+v", job)
	}
	// Later runtime shutdown must update current state, but not erase an action's
	// durable exact-success evidence in rollout history.
	identity := first.Identity()
	if e := f.transports["fleet-a"].ReportObservation(context.Background(), first.Scope, controlprotocol.State{Desired: &identity, Phase: "stopped", Code: "local_session_stopped"}); e != nil {
		t.Fatal(e)
	}
	job = f.job(t, id)
	if job.Targets[0].Status != "succeeded" {
		t.Fatalf("historical success overwritten: %+v", job)
	}
}

func TestFleetHostsRetainValidatedGroupingAndTags(t *testing.T) {
	f := newFleetFixture(t)
	f.post(t, "hosts", map[string]any{"id": "host-fleet-a", "name": "Europe", "address": "127.0.0.1", "group": "production-eu", "tags": []string{"cn2", "monthly-800g"}}, 200)
	code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/hosts", "", nil)
	if code != 200 || !strings.Contains(raw, "production-eu") || !strings.Contains(raw, "monthly-800g") {
		t.Fatal("group/tag metadata lost", raw)
	}
	f.post(t, "hosts", map[string]any{"id": "host-fleet-a", "name": "Europe", "address": "127.0.0.1", "tags": []string{"duplicate", "duplicate"}}, 400)
}

func TestFleetRollbackRefreshesCredentialsAndDoesNotResurrectRevokedGrants(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	alice := inviteClient(t, f.s, f.srv, "fleet-alice")
	bob := inviteClient(t, f.s, f.srv, "fleet-bob")
	instance := domain.CoreInstance{ID: "fleet-a", Name: "Managed entry", HostID: "host-fleet-a", AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}
	endpoint := domain.ManagedEndpoint{ID: "entry-fleet-a", InstanceID: instance.ID, Name: "Managed public", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 23456, UUID: "00000000-0000-4000-8000-000000000001"}}
	f.post(t, "core-instances", instance, 200)
	f.post(t, "managed-endpoints", endpoint, 200)
	deployment := httpapi.ServerDeployment{ID: f.in.DeploymentID, Name: "Managed fleet", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: f.in.DeploymentID, TopologyRevision: "fleet-topology", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint}}}}
	f.saveDeployment(t, deployment)
	f.post(t, "published-routes", map[string]any{"id": "fleet-route", "name": "Managed route", "deploymentId": deployment.ID, "endpointIds": []string{endpoint.ID}, "publicHost": "127.0.0.1", "publicPort": 23456}, 200)
	plan := service.Plan{ID: "fleet-plan", Name: "Managed plan", QuotaBytes: 1 << 20, RouteIDs: []string{"fleet-route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	f.post(t, "services", plan, 200)
	for _, id := range []string{alice.id, bob.id} {
		if code, _, raw := req(t, operatorClient(), "PUT", f.srv.URL+"/api/users/"+id+"/entitlement", "", service.Entitlement{ServiceID: plan.ID, Cycle: plan.Cycle}); code != 200 {
			t.Fatal(code, raw)
		}
	}
	uuidA, uuidB, uuidNew := "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000033"
	f.post(t, "published-routes/fleet-route/principals", map[string]any{"accountId": alice.id, "entryId": "alice-entry", "credentialVersion": "v1", "credential": domain.PrincipalCredential{UUID: uuidA}}, 201)
	f.post(t, "published-routes/fleet-route/principals", map[string]any{"accountId": bob.id, "entryId": "bob-entry", "credentialVersion": "v1", "credential": domain.PrincipalCredential{UUID: uuidB}}, 201)
	preview := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	if preview["affectedUsers"] != float64(2) {
		t.Fatalf("impact count not precise: %+v", preview)
	}
	original := f.create(t)
	f.post(t, "admin/fleet-batches/"+original+"/execute", map[string]any{"stage": 0, "requestId": "first"}, 200)
	f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	if code, _, raw := req(t, operatorClient(), "DELETE", f.srv.URL+"/api/users/"+alice.id+"/entries/alice-entry", "", nil); code != 200 {
		t.Fatal(code, raw)
	}
	f.post(t, "published-routes/fleet-route/principals", map[string]any{"accountId": bob.id, "entryId": "bob-entry", "credentialVersion": "v2", "credential": domain.PrincipalCredential{UUID: uuidNew}}, 201)
	f.in.Action = "rollback"
	f.in.SourceBatchID = original
	rolled := f.create(t)
	f.post(t, "admin/fleet-batches/"+rolled+"/execute", map[string]any{"stage": 0, "requestId": "rollback"}, 200)
	var enrollment httpapi.Enrollment
	f.s.Get("instance-enrollments", "fleet-a", &enrollment)
	desired, e := f.transports["fleet-a"].ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if e != nil || desired == nil {
		t.Fatal(e)
	}
	contents := ""
	for _, artifact := range desired.Artifacts {
		contents += artifact.Content
	}
	if strings.Contains(contents, uuidA) || strings.Contains(contents, uuidB) || !strings.Contains(contents, uuidNew) {
		t.Fatal("rollback revived old/revoked credential or omitted current credential")
	}
	if !desired.Lease.AccessAllowed || !desired.Lease.IssuedAt.After(f.job(t, original).CreatedAt) {
		t.Fatal("rollback reused historical lease")
	}
	// Revocation after review invalidates execution, rather than applying the
	// previously reviewed credentials under newly withdrawn authority.
	fresh := f.create(t)
	if code, _, _ := req(t, operatorClient(), "DELETE", f.srv.URL+"/api/users/"+bob.id+"/entries/bob-entry", "", nil); code != 200 {
		t.Fatal(code)
	}
	f.post(t, "admin/fleet-batches/"+fresh+"/execute", map[string]any{"stage": 0, "requestId": "withdrawn"}, 200)
	if job := f.job(t, fresh); job.Targets[0].Status != "failed" {
		t.Fatal("revoked authorization queued")
	}
}

func TestFleetNextStageRejectsSupersededHistoricalSuccess(t *testing.T) {
	f := newFleetFixture(t)
	original := f.create(t)
	f.post(t, "admin/fleet-batches/"+original+"/execute", map[string]any{"stage": 0, "requestId": "first"}, 200)
	f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	stop := f
	stop.in.Action = "stop"
	stop.in.TargetIDs = []string{"fleet-a"}
	stop.in.Stages = nil
	id := stop.create(t)
	stop.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
	f.post(t, "admin/fleet-batches/"+original+"/execute", map[string]any{"stage": 1, "requestId": "stale-next"}, 409)
	if job := f.job(t, original); job.Targets[0].Status != "succeeded" || job.Targets[1].Status != "planned" {
		t.Fatal("stage gate rewrote history or queued stale continuation")
	}
}

func TestFleetInstallRequiresCatalogAndExactInstalledEvidenceNotRunning(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	f.in.Action = "install"
	f.in.TargetReleaseID = "xray-26.10.31-linux-amd64"
	id := f.create(t)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "install"}, 200)
	var enrollment httpapi.Enrollment
	f.s.Get("instance-enrollments", "fleet-a", &enrollment)
	desired, e := f.transports["fleet-a"].ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if e != nil || desired == nil || desired.Action != "install" || desired.CoreReleaseID != f.in.TargetReleaseID {
		t.Fatal("wrong install envelope", desired, e)
	}
	var manifest domain.PublishedManifest
	if e = f.s.Get("published-manifests", desired.RevisionID, &manifest); e != store.ErrNotFound {
		t.Fatal("install published an active-route manifest")
	}
	identity := desired.Identity()
	state := controlprotocol.State{Desired: &identity, Phase: "installed", Code: "artifact_installed", NativeChecked: true}
	f.transports["fleet-a"].ReportObservation(context.Background(), enrollment.Scope, state)
	if f.job(t, id).Status == "succeeded" {
		t.Fatal("installation accepted without digest evidence")
	}
	release, _ := controlprotocol.FindCoreRelease(f.in.TargetReleaseID)
	state.Installation = &controlprotocol.CoreInstallation{ReleaseID: release.ID, AdapterID: release.AdapterID, Version: release.Version, Platform: release.Platform, ExecutableSHA256: release.ExecutableSHA256}
	if e = f.transports["fleet-a"].ReportObservation(context.Background(), enrollment.Scope, state); e != nil {
		t.Fatal(e)
	}
	if f.job(t, id).Status != "succeeded" {
		t.Fatal("matching installed artifact not reflected")
	}
	state.Phase = "stopped"
	state.Installation = nil
	f.transports["fleet-a"].ReportObservation(context.Background(), enrollment.Scope, state)
	if f.job(t, id).Status != "succeeded" {
		t.Fatal("later runtime report erased installation history")
	}
	f.in.TargetReleaseID = "https://attacker.invalid/core"
	f.post(t, "admin/fleet-batches/preview", f.in, 422)
}

func TestFleetUpgradeNamesExactOldNewIdentityAndRejectsUnknownRuntime(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	original := f.create(t)
	f.post(t, "admin/fleet-batches/"+original+"/execute", map[string]any{"stage": 0, "requestId": "original"}, 200)
	desired := f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	// This is an explicitly synthetic prior-version observation fixture, not
	// evidence that this upstream version was installed or executed.
	desired.CoreVersion = "26.2.6"
	// Keep the synthetic accepted publication consistent with its exact identity.
	var priorManifest domain.PublishedManifest
	if e := f.s.Get("published-manifests", desired.RevisionID, &priorManifest); e != nil {
		t.Fatal(e)
	}
	priorManifest.Identity.CoreVersion = desired.CoreVersion
	priorManifest.Program.Instance.Version = desired.CoreVersion
	if e := f.s.Put("published-manifests", desired.RevisionID, priorManifest); e != nil {
		t.Fatal(e)
	}
	f.s.Put("agent-desired", "fleet-a", desired)
	old := desired.Identity()
	state := controlprotocol.State{Desired: &old, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: old, Known: true, Quiescent: true, ObservedAt: time.Now()}}
	f.s.Put("agent-observations", "fleet-a", state)
	f.in.Action = "upgrade"
	f.in.TargetReleaseID = "xray-26.10.31-linux-amd64"
	plan := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	if plan["supported"] != true {
		t.Fatalf("reviewed upgrade rejected: %+v", plan)
	}
	targets := plan["targets"].([]any)
	first := targets[0].(map[string]any)
	if first["currentVersion"] != "26.2.6" || first["coreVersion"] != "26.10.31" {
		t.Fatal("upgrade versions not explicit", first)
	}
	id := f.create(t)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "upgrade"}, 200)
	var enrollment httpapi.Enrollment
	f.s.Get("instance-enrollments", "fleet-a", &enrollment)
	next, e := f.transports["fleet-a"].ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if e != nil || next == nil || next.Transition == nil || next.Transition.From != old || next.Generation <= old.Generation || next.CoreReleaseID != f.in.TargetReleaseID {
		t.Fatal("upgrade omitted exact transition fence", next, e)
	}
	if f.job(t, id).Status == "succeeded" {
		t.Fatal("queued upgrade claimed active")
	}
	state.RecoveryRequired = true
	state.Phase = controlprotocol.Unknown
	f.s.Put("agent-observations", "fleet-a", state)
	blocked := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	if blocked["supported"] != false {
		t.Fatal("uncertain runtime authorized a new upgrade")
	}
}
func TestFleetDiffNeverReturnsNativeCredentials(t *testing.T) {
	f := newFleetFixture(t)
	code, _, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/admin/fleet-batches/preview", "", f.in)
	if code != 200 || strings.Contains(raw, "fixture-user") || strings.Contains(raw, "fixture-password") {
		t.Fatal("native diff leaked credential", code, raw)
	}
	if !strings.Contains(raw, "configDiff") || !strings.Contains(raw, "REDACTED") {
		t.Fatal("usable redacted diff absent", raw)
	}
}

func TestFleetStopUsesAcceptedPackageWhenDraftIsInvalid(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	id := f.create(t)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "configure"}, 200)
	first := f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	var deployment httpapi.ServerDeployment
	f.s.Get("server-deployments", f.in.DeploymentID, &deployment)
	deployment.IR.Programs[0].DefaultAction = domain.ActionRef{Kind: "invalid-draft"}
	f.saveDeployment(t, deployment)
	f.in.Action = "stop"
	stop := f.create(t)
	f.post(t, "admin/fleet-batches/"+stop+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
	var enrollment httpapi.Enrollment
	f.s.Get("instance-enrollments", "fleet-a", &enrollment)
	next, e := f.transports["fleet-a"].ReceiveDesired(context.Background(), enrollment.Scope, 0)
	if e != nil || next == nil || next.Lease.AccessAllowed || next.Digest != first.Digest || next.Generation <= first.Generation {
		t.Fatal("invalid draft prevented safe fenced stop", next, e)
	}
}

func TestFleetCatalogOmitsRetiredReleasesAndRejectsStaleInstallPlans(t *testing.T) {
	f := newFleetFixture(t)
	code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/admin/core-releases", "", nil)
	if code != 200 || !strings.Contains(raw, "xray-26.10.31-linux-amd64") || !strings.Contains(raw, "sing-box-1.14.4-linux-amd64") || strings.Contains(raw, "xray-26.3.27-linux-amd64") || strings.Contains(raw, "sing-box-1.14.3-linux-amd64") {
		t.Fatal("incorrect active release choices", code, raw)
	}
	for _, action := range []string{"install", "upgrade"} {
		for _, id := range []string{"xray-26.3.27-linux-amd64", "sing-box-1.14.3-linux-amd64"} {
			f.in.Action, f.in.TargetReleaseID = action, id
			f.post(t, "admin/fleet-batches/preview", f.in, 422)
			f.post(t, "admin/fleet-batches", map[string]any{"action": action, "deploymentId": f.in.DeploymentID, "targetIds": f.in.TargetIDs, "targetReleaseId": id, "expectedFingerprint": "stale", "leaseSeconds": 300}, 422)
		}
	}
	// Historical draft identities are intentionally still supported; retirement
	// must not make existing configure/review history disappear.
	f.in.Action, f.in.TargetReleaseID = "configure", ""
	f.post(t, "admin/fleet-batches/preview", f.in, 200)
}
