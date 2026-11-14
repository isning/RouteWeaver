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

func TestCoreDiagnosticsAuthenticatedDataPathAndRevocation(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "diagnostic-viewer")
	now := time.Now().UTC()
	host := domain.Host{ID: "diag-host", Name: "Host"}
	instance := domain.CoreInstance{ID: "diag-core", HostID: host.ID, AdapterID: "routeweaver/xray", Version: "26.3.27"}
	s.Put("hosts", host.ID, host)
	s.Put("core-instances", instance.ID, instance)
	base := srv.URL + "/api/admin/instances/" + instance.ID + "/core-diagnostics"
	if code, _, _ := req(t, http.DefaultClient, "GET", base, "", nil); code != 401 {
		t.Fatal(code)
	}
	if code, _, _ := req(t, user.c, "GET", base, "", nil); code != 403 {
		t.Fatal(code)
	}
	if code, out, _ := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "not_reported" {
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
	report := diagnostics.CoreReport{Scope: scope, Sequence: 1, Events: []diagnostics.CoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Code: "listener_address_in_use", ObservedAt: now}}}
	report.Digest = diagnostics.CoreReportDigest(report)
	if _, e = tr.ReportCoreDiagnostics(context.Background(), report); e != nil {
		t.Fatal(e)
	}
	if receipt, e := tr.ReportCoreDiagnostics(context.Background(), report); e != nil || !receipt.Duplicate {
		t.Fatalf("retry %+v %v", receipt, e)
	}
	if code, out, body := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "recent" || len(out["events"].([]any)) != 1 {
		t.Fatalf("view %d %s", code, body)
	}
	report.Sequence++
	report.Events[0].Code = "secret://not-a-fixed-code"
	report.Digest = diagnostics.CoreReportDigest(report)
	if _, e = tr.ReportCoreDiagnostics(context.Background(), report); e == nil {
		t.Fatal("raw field accepted")
	}
	if code, _, body = req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)}); code != 201 {
		t.Fatal(body)
	}
	if _, e = tr.ReportCoreDiagnostics(context.Background(), report); e == nil {
		t.Fatal("old enrollment accepted")
	}
	if code, out, _ := req(t, admin, "GET", base, "", nil); code != 200 || out["collectionState"] != "not_reported" || len(out["events"].([]any)) != 0 {
		t.Fatalf("old history surfaced %d %+v", code, out)
	}
}
