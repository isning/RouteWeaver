package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/observability"
	"testing"
	"testing/fstest"
	"time"
)

func TestNodeResourcesAndProviderAllowanceHaveAuthenticatedEndToEndDataPath(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "resource-viewer")
	host := domain.Host{ID: "resource-node", Name: "Operator node", Address: "127.0.0.1"}
	instance := domain.CoreInstance{ID: "resource-core", HostID: host.ID}
	for _, v := range []struct {
		kind, id string
		value    any
	}{{"hosts", host.ID, host}, {"core-instances", instance.ID, instance}} {
		if e := s.Put(v.kind, v.id, v.value); e != nil {
			t.Fatal(e)
		}
	}
	base := srv.URL + "/api/admin/nodes/" + host.ID + "/observability"
	if code, _, _ := req(t, http.DefaultClient, "GET", base, "", nil); code != 401 {
		t.Fatalf("unauthenticated node data %d", code)
	}
	if code, _, _ := req(t, user.c, "GET", base, "", nil); code != 403 {
		t.Fatalf("tenant node data %d", code)
	}
	for _, c := range []struct {
		client *http.Client
		want   int
	}{{http.DefaultClient, 401}, {user.c, 403}} {
		if code, _, _ := req(t, c.client, "GET", base+"/history", "", nil); code != c.want {
			t.Fatalf("history authorization %d want %d", code, c.want)
		}
	}
	if code, _, body := req(t, admin, "GET", base+"/history", "", nil); code != 200 {
		t.Fatalf("empty history %d %s", code, body)
	}
	if code, _, _ := req(t, admin, "GET", base+"/history?window=forever", "", nil); code != 400 {
		t.Fatalf("invalid window %d", code)
	}
	if code, _, _ := req(t, admin, "GET", base+"/history?window=7d", "", nil); code != 200 {
		t.Fatalf("weekly window %d", code)
	}
	now := time.Now().UTC()
	cfg := observability.Config{ObserverInstanceID: instance.ID, BilledInterfaces: []string{"eth0"}, Provider: &observability.ProviderConfig{Name: "ISP", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "nic_estimate", ExhaustionAction: "advisory"}}
	if code, _, body := req(t, admin, "PUT", base+"/config", "", cfg); code != 200 {
		t.Fatalf("configure %d %s", code, body)
	}
	if code, _, _ := req(t, admin, "PUT", base+"/config", "", cfg); code != 409 {
		t.Fatalf("revision overwrite %d", code)
	}
	code, enrolled, body := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)})
	if code != 201 {
		t.Fatalf("enroll %d %s", code, body)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	if e := json.Unmarshal(b, &scope); e != nil {
		t.Fatal(e)
	}
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	report := observability.Report{Scope: observability.Scope(scope), StreamEpoch: "test-stream", Sequence: 1, ObservedAt: now.Add(-time.Minute), Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, CPUIdleTicks: 50, MemoryTotalBytes: 1000, MemoryAvailableBytes: 500, Load1: 0.5, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000}, {Name: "lo", ReceiveBytes: 999999, TransmitBytes: 999999}}}}
	report.Digest = observability.ReportDigest(report)
	if _, e = tr.ReportNodeObservation(context.Background(), report); e != nil {
		t.Fatal(e)
	}
	if receipt, e := tr.ReportNodeObservation(context.Background(), report); e != nil || !receipt.Duplicate {
		t.Fatalf("retry %+v %v", receipt, e)
	}
	code, out, body := req(t, admin, "GET", base, "", nil)
	if code != 200 {
		t.Fatalf("read %d %s", code, body)
	}
	latest := out["latest"].(map[string]any)
	p := out["provider"].(map[string]any)
	if latest["cpuPercent"] != nil || p["remainingBytes"] != nil || p["notificationEligible"] != false {
		t.Fatalf("initial unknown data fabricated %s", body)
	}
	baseline := observability.BaselineInput{CycleID: "cycle", UsedBytes: 990000000, ReportDigest: report.Digest, Reason: "provider portal reconciliation at this sample"}
	if code, _, body = req(t, admin, "POST", base+"/baseline", "", baseline); code != 200 {
		t.Fatalf("baseline %d %s", code, body)
	}
	report.Sequence++
	report.ObservedAt = now
	report.Metrics.CPUTotalTicks = 200
	report.Metrics.CPUIdleTicks = 75
	report.Metrics.Interfaces[0].ReceiveBytes += 100
	report.Metrics.Interfaces[0].TransmitBytes += 200
	report.Digest = observability.ReportDigest(report)
	if _, e = tr.ReportNodeObservation(context.Background(), report); e != nil {
		t.Fatal(e)
	}
	code, out, body = req(t, admin, "GET", base, "", nil)
	if code != 200 {
		t.Fatalf("view %d %s", code, body)
	}
	latest = out["latest"].(map[string]any)
	p = out["provider"].(map[string]any)
	if latest["cpuPercent"] != float64(75) || p["remainingBytes"] != float64(9999700) || p["observedNicBytes"] != float64(300) || p["source"] != "nic_estimate" {
		t.Fatalf("real selected IN+OUT data missing %s", body)
	}
	// Quota notification is driven by the node source, not a tenant meter.
	if _, err := httpapi.RunNotificationBatch(context.Background(), s, "", now); err != nil {
		t.Fatal(err)
	}
	code, _, body = req(t, admin, "GET", srv.URL+"/api/me/notifications", "", nil)
	if code != 200 {
		t.Fatalf("provider notification %d %s", code, body)
	}
	var notifications []map[string]any
	if e = json.Unmarshal([]byte(body), &notifications); e != nil {
		t.Fatal(e)
	}
	found := false
	for _, n := range notifications {
		found = found || n["kind"] == "provider-quota"
	}
	if !found {
		t.Fatalf("fresh configured source did not reach notifications: %s", body)
	}
	// Revocation and changed enrollment must invalidate even an otherwise valid report.
	if code, _, body = req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)}); code != 201 {
		t.Fatalf("reenroll %d %s", code, body)
	}
	if _, e = tr.ReportNodeObservation(context.Background(), report); e == nil {
		t.Fatal("superseded enrollment reported node")
	}
}

func TestNodeObservationScopeAndProviderStatementAuthorization(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "provider-tenant")
	now := time.Now().UTC()
	for _, v := range []struct {
		kind, id string
		value    any
	}{
		{"hosts", "physical", domain.Host{ID: "physical", Name: "Physical", Address: "127.0.0.1"}},
		{"core-instances", "one", domain.CoreInstance{ID: "one", HostID: "physical"}},
		{"core-instances", "two", domain.CoreInstance{ID: "two", HostID: "physical"}},
		{"hosts", "other", domain.Host{ID: "other", Name: "Other", Address: "127.0.0.1"}},
		{"core-instances", "foreign", domain.CoreInstance{ID: "foreign", HostID: "other"}},
	} {
		if e := s.Put(v.kind, v.id, v.value); e != nil {
			t.Fatal(e)
		}
	}
	base := srv.URL + "/api/admin/nodes/physical/observability"
	config := observability.Config{ObserverInstanceID: "foreign", BilledInterfaces: []string{"eth0"}}
	if code, _, _ := req(t, admin, "PUT", base+"/config", "", config); code != 403 {
		t.Fatalf("foreign observer configuration %d", code)
	}
	config.ObserverInstanceID = "one"
	config.Provider = &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 800, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "advisory"}
	if code, _, body := req(t, admin, "PUT", base+"/config", "", config); code != 200 {
		t.Fatalf("configure %d %s", code, body)
	}
	statement := observability.StatementInput{CycleID: "cycle", UsedBytes: 799000000000, ObservedAt: now, Reference: "provider portal statement reference"}
	if code, _, _ := req(t, user.c, "POST", base+"/provider-statement", "", statement); code != 403 {
		t.Fatalf("tenant changed provider statement %d", code)
	}
	if code, _, body := req(t, admin, "POST", base+"/provider-statement", "", statement); code != 200 {
		t.Fatalf("statement %d %s", code, body)
	}
	// Even another legitimately enrolled core on the same physical node cannot
	// duplicate node accounting. This is independent of runtime adapter family.
	code, enrolled, body := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": "physical", "instanceId": "two", "expiresAt": now.Add(time.Hour)})
	if code != 201 {
		t.Fatalf("enroll %d %s", code, body)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	json.Unmarshal(b, &scope)
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	report := observability.Report{Scope: observability.Scope(scope), StreamEpoch: "stream", Sequence: 1, ObservedAt: now, Metrics: observability.Metrics{CounterEpoch: "boot", CPUTotalTicks: 100, MemoryTotalBytes: 100, Interfaces: []observability.Interface{{Name: "eth0"}}}}
	report.Digest = observability.ReportDigest(report)
	if _, e = tr.ReportNodeObservation(context.Background(), report); e == nil {
		t.Fatal("second core accepted as node observer")
	}
	code, out, body := req(t, admin, "GET", base, "", nil)
	if code != 200 || out["latest"] != nil || out["provider"].(map[string]any)["remainingBytes"] != float64(1000000000) {
		t.Fatalf("statement fabricated resource observation %d %s", code, body)
	}
}

func TestDriverCollectsNodeProcfsThroughRealHTTPAdapter(t *testing.T) {
	s, srv := makeServer(t)
	now := time.Now().UTC()
	admin := operatorClient()
	host := domain.Host{ID: "driver-node", Name: "Synthetic fixture", Address: "127.0.0.1"}
	instance := domain.CoreInstance{ID: "driver-core", HostID: host.ID}
	if e := s.Put("hosts", host.ID, host); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("core-instances", instance.ID, instance); e != nil {
		t.Fatal(e)
	}
	if _, e := s.ConfigureNodeObservations(host.ID, observability.Config{ObserverInstanceID: instance.ID, BilledInterfaces: []string{"eth0"}}); e != nil {
		t.Fatal(e)
	}
	code, enrolled, body := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": now.Add(time.Hour)})
	if code != 201 {
		t.Fatalf("enroll %d %s", code, body)
	}
	var scope agent.Scope
	b, _ := json.Marshal(enrolled["scope"])
	json.Unmarshal(b, &scope)
	tr, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: enrolled["token"].(string), RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	fixtures := fstest.MapFS{
		"stat":                      {Data: []byte("cpu 100 0 20 500 0 0 0 0\n")},
		"meminfo":                   {Data: []byte("MemTotal: 1024 kB\nMemAvailable: 512 kB\n")},
		"loadavg":                   {Data: []byte("0.2 0.4 0.6 1/100 123\n")},
		"net/dev":                   {Data: []byte("eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n")},
		"sys/kernel/random/boot_id": {Data: []byte("test-boot\n")},
	}
	observer, e := agent.NewNodeObserver(scope, agent.NewNodeCollector(fixtures))
	if e != nil {
		t.Fatal(e)
	}
	reconciler, e := agent.Open(filepath.Join(t.TempDir(), "driver"), scope, agent.NewRegistry(agent.LocalFixture{}), agent.Options{MaxLease: time.Minute})
	if e != nil {
		t.Fatal(e)
	}
	defer reconciler.Close()
	if _, e = agent.RunDriver(context.Background(), reconciler, tr, nil, agent.DriverOptions{NodeObserver: observer, PollInterval: 10 * time.Millisecond, LeaseInterval: 10 * time.Millisecond, MaxRuntime: 100 * time.Millisecond}); e != nil {
		t.Fatal(e)
	}
	state, e := s.NodeObservations(host.ID)
	if e != nil || state.Latest == nil {
		t.Fatalf("driver did not publish node data: %+v %v", state, e)
	}
	if state.Latest.Source != "linux_procfs" || state.Latest.Metrics.MemoryTotalBytes != 1048576 || state.Latest.Metrics.Interfaces[0].TransmitBytes != 200 {
		t.Fatalf("procfs data path: %+v", state.Latest)
	}
	if state.Config.Provider != nil || state.Latest.CPUPercent != nil {
		t.Fatal("unconfigured provider or unchanged CPU counters fabricated a value")
	}
}
