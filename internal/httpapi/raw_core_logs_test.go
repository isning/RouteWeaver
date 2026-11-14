package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestRawCoreLogsAuthenticatedDataPathAndRevocation(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "diagnostic-viewer")
	now := time.Now().UTC()
	host := domain.Host{ID: "diag-host", Name: "Host"}
	instance := domain.CoreInstance{ID: "diag-core", HostID: host.ID, AdapterID: "routeweaver/xray", Version: "26.3.27"}
	s.Put("hosts", host.ID, host)
	s.Put("core-instances", instance.ID, instance)
	base := srv.URL + "/api/admin/instances/" + instance.ID + "/core-logs"
	if code, _, _ := req(t, http.DefaultClient, "GET", base, "", nil); code != 401 {
		t.Fatal(code)
	}
	if code, _, _ := req(t, user.c, "GET", base, "", nil); code != 403 {
		t.Fatal(code)
	}
	if code, out, _ := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "disabled" {
		t.Fatalf("default %d %+v", code, out)
	}
	code, enrolled, body := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)})
	if code != 201 {
		t.Fatal(body)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	json.Unmarshal(b, &scope)
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	report := diagnostics.RawCoreReport{Scope: scope, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Stream: "stderr", Text: "original secret://test", ObservedAt: now}}}
	policy, pe := s.SetRawCoreSettings(instance.ID, "", true, 3600)
	if pe != nil {
		t.Fatal(pe)
	}
	report.PolicyRevision = policy.Revision
	report.Digest = diagnostics.RawCoreReportDigest(report)
	if _, e = tr.ReportRawCoreLogs(context.Background(), report); e != nil {
		t.Fatal(e)
	}
	if receipt, e := tr.ReportRawCoreLogs(context.Background(), report); e != nil || !receipt.Duplicate {
		t.Fatalf("retry %+v %v", receipt, e)
	}
	if code, out, body := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "recent" || len(out["events"].([]any)) != 1 {
		t.Fatalf("view %d %s", code, body)
	}
	for _, filter := range []string{"?stream=stdout", "?q=absent", "?since=" + now.Add(time.Minute).Format(time.RFC3339)} {
		if code, out, _ := req(t, admin, "GET", base+filter, "", nil); code != 200 || len(out["events"].([]any)) != 0 {
			t.Fatalf("filter failed %s %d %+v", filter, code, out)
		}
	}
	for _, filter := range []string{"?stream=oops", "?since=bad", "?format=csv"} {
		if code, _, _ := req(t, admin, "GET", base+filter, "", nil); code != 400 {
			t.Fatalf("filter accepted %s %d", filter, code)
		}
	}
	response, err := admin.Get(base + "?format=ndjson&stream=stderr&q=original")
	if err != nil {
		t.Fatal(err)
	}
	var event diagnostics.RawCoreRecord
	err = json.NewDecoder(response.Body).Decode(&event)
	response.Body.Close()
	if err != nil || event.Text != "original secret://test" || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Content-Type") != "application/x-ndjson" || response.Header.Get("Content-Disposition") == "" {
		t.Fatalf("export mismatch %v %+v", err, response.Header)
	}
	report.Sequence++
	report.Events[0].Stream = "invalid"
	report.Digest = diagnostics.RawCoreReportDigest(report)
	if _, e = tr.ReportRawCoreLogs(context.Background(), report); e == nil {
		t.Fatal("invalid stream accepted")
	}
	if code, _, body = req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)}); code != 201 {
		t.Fatal(body)
	}
	if _, e = tr.ReportRawCoreLogs(context.Background(), report); e == nil {
		t.Fatal("old enrollment accepted")
	}
	if code, out, _ := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "not_reported" || len(out["events"].([]any)) != 0 {
		t.Fatalf("old history surfaced %d %+v", code, out)
	}
}

func TestRawCoreSettingsAdminScopeCASAndRetention(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "settings-user")
	s.Put("core-instances", "settings-core", domain.CoreInstance{ID: "settings-core", HostID: "node", AdapterID: "routeweaver/xray"})
	base := srv.URL + "/api/admin/instances/settings-core/core-logs/settings"
	for _, c := range []struct {
		client *http.Client
		status int
	}{{http.DefaultClient, 401}, {user.c, 403}} {
		if code, _, _ := req(t, c.client, "GET", base, "", nil); code != c.status {
			t.Fatal(code)
		}
		if code, _, _ := req(t, c.client, "PUT", base, user.csrf, map[string]any{"expectedRevision": "", "enabled": true, "retentionSeconds": 3600}); code != c.status {
			t.Fatal(code)
		}
	}
	code, p, raw := req(t, admin, "GET", base, "", nil)
	if code != 200 || p["enabled"] != false || p["revision"] != "" {
		t.Fatalf("default %d %s", code, raw)
	}
	code, p, raw = req(t, admin, "PUT", base, "", map[string]any{"expectedRevision": "", "enabled": true, "retentionSeconds": 86400})
	if code != 200 || p["enabled"] != true || p["revision"] == "" {
		t.Fatalf("save %d %s", code, raw)
	}
	if code, _, _ := req(t, admin, "PUT", base, "", map[string]any{"expectedRevision": "", "enabled": false, "retentionSeconds": 3600}); code != 409 {
		t.Fatal(code)
	}
	if code, _, _ := req(t, admin, "PUT", base, "", map[string]any{"expectedRevision": p["revision"], "enabled": false, "retentionSeconds": 7}); code != 400 {
		t.Fatal(code)
	}
}

func TestRawCorePolicyJoinedAgentCaptureAndDisable(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	now := time.Now().UTC()
	host := domain.Host{ID: "policy-host", Name: "Policy Host"}
	core := domain.CoreInstance{ID: "policy-core", HostID: host.ID, AdapterID: "routeweaver/xray", Version: "26.3.27"}
	s.Put("hosts", host.ID, host)
	s.Put("core-instances", core.ID, core)
	code, enrolled, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": core.ID, "expiresAt": now.Add(time.Hour)})
	if code != 201 {
		t.Fatal(raw)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	json.Unmarshal(b, &scope)
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	// Creating the collector represents the explicit local opt-in. A default-off
	// agent never constructs it; platform policy alone cannot create one remotely.
	capture, e := agent.OpenRawCoreLogs(scope)
	if e != nil {
		t.Fatal(e)
	}
	defer capture.Close()
	writer := capture.NewWriter(core.AdapterID, core.Version, "stderr")
	defer writer.Close()
	writer.Write([]byte("before-policy-must-not-upload\n"))
	if e = capture.Flush(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	base := srv.URL + "/api/admin/instances/" + core.ID + "/core-logs"
	code, policy, raw := req(t, admin, "PUT", base+"/settings", "", map[string]any{"expectedRevision": "", "enabled": true, "retentionSeconds": 86400})
	if code != 200 {
		t.Fatal(raw)
	}
	if e = capture.Flush(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	writer.Write([]byte("explicitly-consented-raw-output\n"))
	// The real receiver enforces a five-second report cadence. Do not bypass it.
	time.Sleep(5100 * time.Millisecond)
	if e = capture.Flush(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	code, view, raw := req(t, admin, "GET", base, "", nil)
	if code != 200 || len(view["events"].([]any)) != 1 || view["events"].([]any)[0].(map[string]any)["text"] != "explicitly-consented-raw-output" {
		t.Fatalf("joined capture %d %s", code, raw)
	}
	writer.Write([]byte("unsent-secret\npartial-secret"))
	code, _, raw = req(t, admin, "PUT", base+"/settings", "", map[string]any{"expectedRevision": policy["revision"], "enabled": false, "retentionSeconds": 86400})
	if code != 200 {
		t.Fatal(raw)
	}
	if e = capture.Flush(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	writer.Write([]byte("disabled-secret\n"))
	writer.Close()
	if e = capture.Flush(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	code, view, raw = req(t, admin, "GET", base, "", nil)
	if code != 200 || view["collectionState"] != "disabled" || len(view["events"].([]any)) != 0 {
		t.Fatalf("disabled content revived %d %s", code, raw)
	}
}
