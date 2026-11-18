package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"routeweaver/internal/agent"
	"routeweaver/internal/observability"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func hostWire(t *testing.T, base, path, token, node, epoch string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest("GET", base+"/api/"+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-RouteWeaver-Node", node)
	request.Header.Set("X-RouteWeaver-Enrollment", epoch)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body json.RawMessage
	if response.StatusCode != 204 {
		_ = json.NewDecoder(response.Body).Decode(&body)
	}
	return response.StatusCode, body
}
func TestHostAgentEnrollsBeforeCoresAndOwnsNewInstances(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	host := domain.Host{ID: "host-agent-a", Name: "Host A", Address: "192.0.2.1"}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/hosts", "", host); code != 200 {
		t.Fatal("create host", code)
	}
	enroll := func() (string, string) {
		code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", map[string]any{"nodeId": host.ID, "expiresAt": time.Now().Add(time.Hour)})
		if code != 201 {
			t.Fatal("enroll host", code, out["error"])
		}
		scope := out["scope"].(map[string]any)
		if scope["instanceId"] != nil {
			t.Fatal("host credential bound to core")
		}
		return out["token"].(string), scope["enrollmentEpoch"].(string)
	}
	token, epoch := enroll()
	code, body := hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", token, host.ID, epoch)
	var assignments controlprotocol.HostAssignments
	if code != 200 || json.Unmarshal(body, &assignments) != nil || len(assignments.Instances) != 0 {
		t.Fatal("empty host cannot connect", code)
	}
	for _, id := range []string{"core-a", "core-b"} {
		core := domain.CoreInstance{ID: id, Name: id, HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/core-instances", "", core); code != 200 {
			t.Fatal("create inherited core", code)
		}
	}
	code, body = hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", token, host.ID, epoch)
	if code != 200 || json.Unmarshal(body, &assignments) != nil || len(assignments.Instances) != 2 {
		t.Fatal("one host did not discover both cores", code)
	}
	child := assignments.Instances[0]
	if child.Token == token || child.Token == assignments.Instances[1].Token || child.Scope.EnrollmentEpoch == assignments.Instances[1].Scope.EnrollmentEpoch {
		t.Fatal("instance isolation lost")
	}
	if code, _ := hostWire(t, srv.URL, "agent/instances/"+child.Scope.InstanceID+"/desired", child.Token, host.ID, child.Scope.EnrollmentEpoch); code != 204 {
		t.Fatal("child credential failed", code)
	}
	if code, _ := hostWire(t, srv.URL, "agent/instances/"+assignments.Instances[1].Scope.InstanceID+"/desired", child.Token, host.ID, child.Scope.EnrollmentEpoch); code != 401 {
		t.Fatal("child escaped instance scope", code)
	}
	code, _, _ = req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": host.ID, "instanceId": child.Scope.InstanceID, "expiresAt": time.Now().Add(time.Hour)})
	if code != 409 {
		t.Fatal("core-specific enrollment allowed on host agent", code)
	}
	nextToken, nextEpoch := enroll()
	if code, _ := hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", token, host.ID, epoch); code != 401 {
		t.Fatal("old host token survived rotation", code)
	}
	if code, _ := hostWire(t, srv.URL, "agent/instances/"+child.Scope.InstanceID+"/desired", child.Token, host.ID, child.Scope.EnrollmentEpoch); code != 401 {
		t.Fatal("old child token survived rotation", code)
	}
	if code, _ := hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", nextToken, host.ID, nextEpoch); code != 200 {
		t.Fatal("new host token failed", code)
	}
	code, out, raw := req(t, admin, "GET", srv.URL+"/api/agent/hosts/"+host.ID+"/state", "", nil)
	if code != 200 || out["phase"] != "online" {
		t.Fatal("host heartbeat status missing", code)
	}
	var view map[string]any
	json.Unmarshal([]byte(raw), &view)
	if view["token"] != nil || view["derivationKey"] != nil || view["tokenDigest"] != nil {
		t.Fatal("host status leaked authority")
	}
	code, _, _ = req(t, admin, "POST", srv.URL+"/api/agent/hosts/"+host.ID+"/revoke", "", map[string]any{})
	if code != 200 {
		t.Fatal("revoke host", code)
	}
	if code, _ := hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", nextToken, host.ID, nextEpoch); code != 401 {
		t.Fatal("revoked host remained authorized", code)
	}
}

func TestHostAgentRequiresAdministratorAndExactHostScope(t *testing.T) {
	s, srv := makeServer(t)
	member := inviteClient(t, s, srv, "host-agent-member")
	admin := operatorClient()
	for _, id := range []string{"host-a", "host-b"} {
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/hosts", "", domain.Host{ID: id, Name: id, Address: "192.0.2.1"}); code != 200 {
			t.Fatal(code)
		}
	}
	payload := map[string]any{"nodeId": "host-a", "expiresAt": time.Now().Add(time.Hour)}
	if code, _, _ := req(t, member.c, "POST", srv.URL+"/api/agent/hosts/enrollments", member.csrf, payload); code != 403 {
		t.Fatal("member enrolled agent", code)
	}
	code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", payload)
	if code != 201 {
		t.Fatal(code)
	}
	token := out["token"].(string)
	epoch := out["scope"].(map[string]any)["enrollmentEpoch"].(string)
	if code, _ := hostWire(t, srv.URL, "agent/hosts/host-b/assignments", token, "host-b", epoch); code != 401 {
		t.Fatal("host token crossed hosts", code)
	}
	if code, _, _ := req(t, member.c, "GET", srv.URL+"/api/agent/hosts/host-a/state", "", nil); code != 403 {
		t.Fatal("member read agent administration", code)
	}
}

func TestHostAgentQueuesInstallWithoutListenerConfiguration(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	host := domain.Host{ID: "install-host", Name: "Install host", Address: "192.0.2.4"}
	core := domain.CoreInstance{ID: "install-core", HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}
	for _, item := range []struct {
		kind  string
		value any
	}{{"hosts", host}, {"core-instances", core}} {
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/"+item.kind, "", item.value); code != 200 {
			t.Fatal(code)
		}
	}
	code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", map[string]any{"nodeId": host.ID, "expiresAt": time.Now().Add(time.Hour)})
	if code != 201 {
		t.Fatal(code)
	}
	token := out["token"].(string)
	epoch := out["scope"].(map[string]any)["enrollmentEpoch"].(string)
	path := srv.URL + "/api/admin/hosts/" + host.ID + "/cores/" + core.ID + "/install"
	if code, _, _ := req(t, admin, "POST", path, "", map[string]any{"releaseId": "xray-26.10.31-linux-amd64", "expectedGeneration": "0"}); code != 202 {
		t.Fatal("queue install without listener", code)
	}
	code, raw := hostWire(t, srv.URL, "agent/hosts/"+host.ID+"/assignments", token, host.ID, epoch)
	var manifest controlprotocol.HostAssignments
	if code != 200 || json.Unmarshal(raw, &manifest) != nil || len(manifest.Instances) != 1 {
		t.Fatal("assignment unavailable", code)
	}
	child := manifest.Instances[0]
	code, raw = hostWire(t, srv.URL, "agent/instances/"+core.ID+"/desired", child.Token, host.ID, child.Scope.EnrollmentEpoch)
	var desired controlprotocol.Desired
	if code != 200 || json.Unmarshal(raw, &desired) != nil || desired.Action != "install" || desired.Lease.AccessAllowed || controlprotocol.ValidateDesired(desired, child.Scope) != nil {
		t.Fatal("invalid installation payload", code)
	}
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{
		BaseURL: srv.URL, Token: child.Token, Scope: child.Scope, AllowLoopbackHTTP: true, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	identity := desired.Identity()
	observation := controlprotocol.State{Desired: &identity, HighestAccepted: desired.Generation, Phase: controlprotocol.Blocked, Code: "core_installation_failed", ErrorDetail: "read core archive: unexpected EOF"}
	if err := transport.ReportObservation(context.Background(), child.Scope, observation); err != nil {
		t.Fatal(err)
	}
	_, _, observed := req(t, admin, "GET", srv.URL+"/api/agent/instances/"+core.ID+"/state", "", nil)
	var view struct{ State controlprotocol.State }
	if err := json.Unmarshal([]byte(observed), &view); err != nil || view.State.ErrorDetail != observation.ErrorDetail {
		t.Fatal("installation error did not survive its observation round trip", err)
	}

	if code, _, _ := req(t, admin, "POST", path, "", map[string]any{"releaseId": "xray-26.10.31-linux-amd64", "expectedGeneration": "0"}); code != 409 {
		t.Fatal("stale installation was replayed", code)
	}
	if code, _, _ := req(t, admin, "POST", path, "", map[string]any{"releaseId": "https://untrusted.example/core", "expectedGeneration": "1"}); code != 400 {
		t.Fatal("unreviewed release accepted", code)
	}
}

func TestHostAgentReportsPhysicalResourcesWithNoCore(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	host := domain.Host{ID: "resource-host", Name: "Empty host", Address: "192.0.2.5"}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/hosts", "", host); code != 200 {
		t.Fatal(code)
	}
	code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", map[string]any{"nodeId": host.ID, "expiresAt": time.Now().Add(time.Hour)})
	if code != 201 {
		t.Fatal(code)
	}
	epoch := out["scope"].(map[string]any)["enrollmentEpoch"].(string)
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: out["token"].(string), Scope: agent.Scope{NodeID: host.ID, InstanceID: "host-agent", EnrollmentEpoch: epoch}, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	report := observability.Report{HostAgent: true, Scope: observability.Scope{NodeID: host.ID, EnrollmentEpoch: epoch}, StreamEpoch: "stream-a", Sequence: 1, ObservedAt: time.Now().UTC(), Metrics: observability.Metrics{CounterEpoch: "boot-a", CPUTotalTicks: 100, CPUIdleTicks: 50, MemoryTotalBytes: 1024, MemoryAvailableBytes: 512, Interfaces: []observability.Interface{{Name: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000}}}}
	report.Digest = observability.ReportDigest(report)
	receipt, err := transport.ReportNodeObservation(context.Background(), report)
	if err != nil || receipt.Sequence != 1 {
		t.Fatal("host resource report failed", err)
	}
	duplicate, err := transport.ReportNodeObservation(context.Background(), report)
	if err != nil || !duplicate.Duplicate {
		t.Fatal("host resource retry not deduplicated", err)
	}
	code, view, _ := req(t, admin, "GET", srv.URL+"/api/admin/nodes/"+host.ID+"/observability", "", nil)
	if code != 200 || view["latest"] == nil {
		t.Fatal("empty host resource view unavailable", code)
	}
	config := view["config"].(map[string]any)
	if config["observerKind"] != "host-agent" || config["observerInstanceId"] != "" {
		t.Fatal("host metrics still depend on a core")
	}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/"+host.ID+"/revoke", "", map[string]any{}); code != 200 {
		t.Fatal(code)
	}
	report.Sequence++
	report.Digest = observability.ReportDigest(report)
	if _, err = transport.ReportNodeObservation(context.Background(), report); err == nil {
		t.Fatal("revoked host still reports resources")
	}
}

func TestHostAgentMovingCoreTransfersOnlyItsAuthority(t *testing.T) {
	_, srv := makeServer(t)
	admin := operatorClient()
	type authority struct{ token, epoch string }
	roots := map[string]authority{}
	for _, id := range []string{"move-host-a", "move-host-b"} {
		if code, _, _ := req(t, admin, "POST", srv.URL+"/api/hosts", "", domain.Host{ID: id, Name: id, Address: "192.0.2.7"}); code != 200 {
			t.Fatal(code)
		}
		code, out, _ := req(t, admin, "POST", srv.URL+"/api/agent/hosts/enrollments", "", map[string]any{"nodeId": id, "expiresAt": time.Now().Add(time.Hour)})
		if code != 201 {
			t.Fatal(code)
		}
		roots[id] = authority{out["token"].(string), out["scope"].(map[string]any)["enrollmentEpoch"].(string)}
	}
	core := domain.CoreInstance{ID: "moving-core", Name: "Moving", HostID: "move-host-a", AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/core-instances", "", core); code != 200 {
		t.Fatal(code)
	}
	read := func(host string) controlprotocol.HostAssignments {
		t.Helper()
		a := roots[host]
		code, raw := hostWire(t, srv.URL, "agent/hosts/"+host+"/assignments", a.token, host, a.epoch)
		var result controlprotocol.HostAssignments
		if code != 200 || json.Unmarshal(raw, &result) != nil {
			t.Fatal("assignment read failed", code)
		}
		return result
	}
	before := read(core.HostID).Instances[0]
	core.HostID = "move-host-b"
	if code, _, _ := req(t, admin, "PUT", srv.URL+"/api/core-instances/"+core.ID, "", core); code != 200 {
		t.Fatal(code)
	}
	if len(read("move-host-a").Instances) != 0 {
		t.Fatal("old server retained moved core")
	}
	after := read("move-host-b").Instances
	if len(after) != 1 || after[0].Scope.NodeID != core.HostID || after[0].Token == before.Token {
		t.Fatal("new server did not receive isolated authority")
	}
	if code, _ := hostWire(t, srv.URL, "agent/instances/"+core.ID+"/desired", before.Token, before.Scope.NodeID, before.Scope.EnrollmentEpoch); code != 401 {
		t.Fatal("old server retained core authority", code)
	}
	if code, _ := hostWire(t, srv.URL, "agent/instances/"+core.ID+"/desired", after[0].Token, core.HostID, after[0].Scope.EnrollmentEpoch); code != 204 {
		t.Fatal("new server could not manage core", code)
	}
}
