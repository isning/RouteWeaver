package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"strings"
	"testing"
)

// Joined with the real published-route authoring/rendering/desired/observation
// flow, not a fabricated HTTP path descriptor. Observations in the fast caller
// are a fixture; the opt-in native caller supplies actual process observations.
func assertPublishedDiagnosticSelection(t *testing.T, base string, admin, tenant *http.Client, tr *agent.HTTPTransport, scope agent.Scope, privateTransit string) {
	t.Helper()
	url := base + "/api/admin/diagnostic-paths"
	if code, _, _ := req(t, tenant, "GET", url, "", nil); code != 403 {
		t.Fatalf("tenant path inventory %d", code)
	}
	code, _, raw := req(t, admin, "GET", url, "", nil)
	var paths []diagnostics.AvailablePath
	if code != 200 || json.Unmarshal([]byte(raw), &paths) != nil || len(paths) != 1 || paths[0].ManagedPath.ConnectorID != "egress-1" || len(paths[0].ManagedPath.Hops) != 2 {
		t.Fatalf("published diagnostic paths %d %s", code, raw)
	}
	if strings.Contains(raw, privateTransit) || strings.Contains(raw, "uuid") || strings.Contains(raw, "password") || strings.Contains(raw, "subjectId") {
		t.Fatal("diagnostic selection leaked principal or transit material")
	}
	target := diagnostics.Target{ID: "published-diagnostic-target", Name: "Authorized HTTPS method target", NodeID: scope.NodeID, URL: "https://example.com/diagnostic", Methods: []string{"connectivity"}}
	if code, _, raw = req(t, admin, "POST", base+"/api/admin/diagnostic-targets", "", target); code != 201 {
		t.Fatalf("target %d %s", code, raw)
	}
	request := diagnostics.Request{ID: "published-diagnostic-job", TargetID: target.ID, InstanceID: scope.InstanceID, Kind: "connectivity", TimeoutSeconds: 1, PathMode: "managed_route", PublishedRouteID: "published-route"}
	code, _, raw = req(t, admin, "POST", base+"/api/admin/diagnostic-jobs", "", request)
	var job diagnostics.Job
	if code != 201 || json.Unmarshal([]byte(raw), &job) != nil || job.ManagedPath == nil || job.Validate(scope) != nil {
		t.Fatalf("managed request %d %s", code, raw)
	}
	if strings.Contains(raw, privateTransit) || strings.Contains(raw, "uuid") || strings.Contains(raw, "password") {
		t.Fatal("diagnostic job leaked connection material")
	}
	override := map[string]any{"id": "override-job", "targetId": target.ID, "instanceId": scope.InstanceID, "kind": "connectivity", "maxBytes": 0, "timeoutSeconds": 1, "pathMode": "managed_route", "publishedRouteId": "published-route", "managedPath": map[string]string{"connectorId": "rw-direct"}}
	if code, _, raw = req(t, admin, "POST", base+"/api/admin/diagnostic-jobs", "", override); code != 400 {
		t.Fatalf("native path override %d %s", code, raw)
	}
	claimed, e := tr.ClaimDiagnostic(context.Background(), scope, "published-diagnostic-attempt")
	if e != nil || claimed == nil || diagnostics.Digest(claimed.ManagedPath) != diagnostics.Digest(job.ManagedPath) {
		t.Fatalf("scoped path claim %v %v", claimed, e)
	}
	// An executor not bound to an exact live managed runtime must never silently
	// fall back to a direct HTTP target. No request to example.com occurs here.
	result := agent.NewDiagnosticExecutor(agent.DiagnosticExecutorOptions{}).Execute(context.Background(), *claimed)
	if result.Status != "not_run" || result.Code != "managed_probe_unavailable" || result.BytesReceived != 0 {
		t.Fatalf("managed path fell back %+v", result)
	}
	if e = tr.ReportDiagnostic(context.Background(), diagnostics.Report{JobID: claimed.ID, Scope: scope, AttemptID: claimed.AttemptID, Result: result}); e != nil {
		t.Fatal(e)
	}
	code, out, raw := req(t, admin, "GET", base+"/api/admin/diagnostic-jobs/"+job.ID, "", nil)
	if code != 200 || out["status"] != "not_run" {
		t.Fatalf("honest unavailable result %d %s", code, raw)
	}
}
