package httpapi_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
)

// This uses the actual scoped HTTP admission transport, not a lease fixture:
// service/grant → immutable desired package → native apply → authenticated
// managed ingress → required native transit → local target → byte settlement.
func TestNativePublishedManagedPrincipalEndToEnd(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN") == "" || os.Getenv("ROUTEWEAVER_CORE_BIN_DIR") == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit managed runtime and Xray process opt-in required")
	}
	testPublishedRoutePrincipals(t, true)
}
func publishedFreePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
func runPublishedNativeTarget(t *testing.T, desired agent.Desired, transport *agent.HTTPTransport) agent.State {
	t.Helper()
	binary := filepath.Join(os.Getenv("ROUTEWEAVER_CORE_BIN_DIR"), "xray")
	if desired.AdapterID == render.ServerAdapterManagedXray {
		binary = os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	}
	root, err := os.MkdirTemp("", "rw-published-")
	if err != nil {
		t.Fatal(err)
	}
	retain := false
	t.Cleanup(func() {
		if !retain {
			os.RemoveAll(root)
		}
	})
	// Builds elsewhere in the shared workspace must not replace the executable
	// underneath the supervisor's exact process-identity check.
	content, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary = filepath.Join(root, "native-core")
	if err = os.WriteFile(binary, content, 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := agent.NewNativeChecker(desired.AdapterID, desired.CoreVersion, binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	reconciler, err := agent.Open(root, desired.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if desired.AdapterID == render.ServerAdapterManagedXray {
		broker, err := agent.StartAdmissionBroker(root, transport)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { broker.Close() })
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := supervisor.Stop(ctx, root); err != nil {
			retain = true
			t.Errorf("native cleanup refused; retained exact identity evidence at %s: %v", root, err)
		}
		reconciler.Close()
	})
	state, err := reconciler.Submit(context.Background(), desired)
	if err != nil || state.Phase != agent.ObservedConformant {
		retain = true
		t.Fatalf("actual published target %s: phase=%s err=%v evidence=%s", desired.InstanceID, state.Phase, err, root)
	}
	return state
}
func provePublishedPrincipalTraffic(t *testing.T, entryPort int, uuid string, clientTLS *tls.Config) {
	t.Helper()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		conn, err := echo.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		payload := make([]byte, len("published-admitted-payload"))
		if _, err = io.ReadFull(conn, payload); err == nil {
			_, _ = conn.Write(payload)
		}
	}()
	conn, err := dialPublishedEntry(entryPort, clientTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	credential, err := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	if err != nil {
		t.Fatal(err)
	}
	port := echo.Addr().(*net.TCPAddr).Port
	header := append([]byte{0}, credential...)
	header = append(header, 0, 1, byte(port>>8), byte(port), 1, 127, 0, 0, 1)
	payload := []byte("published-admitted-payload")
	header = append(header, payload...)
	if _, err = conn.Write(header); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 2)
	if _, err = io.ReadFull(conn, response); err != nil {
		t.Fatalf("real CP admission blocked published credential: %v", err)
	}
	if response[0] != 0 || response[1] != 0 {
		t.Fatal("invalid VLESS response")
	}
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(conn, got); err != nil || string(got) != string(payload) {
		t.Fatalf("published managed path payload: %q %v", got, err)
	}
}

// The same account competes through two real managed ingress processes. The
// control plane atomically reserves one finite combined upload+download budget;
// runtime streams cannot exceed it and final settlement charges it once.
func provePublishedSharedBudget(t *testing.T, post func(string, any) map[string]any, baseURL string, admin *http.Client, user sessionClient, plan service.Plan, hostID string, primaryPort int, primaryUUID string) {
	t.Helper()
	awaitPublishedBudgetsClosed(t, admin, baseURL, "managed-core")
	defer func() {
		if t.Failed() {
			for _, id := range []string{"managed-core", "second-managed-core"} {
				_, _, evidence := req(t, admin, "GET", baseURL+"/api/agent/instances/"+id+"/admission-budgets", "", nil)
				t.Logf("admission budget evidence for %s: %s", id, evidence)
			}
		}
	}()
	port := publishedFreePort(t)
	instance := domain.CoreInstance{ID: "second-managed-core", HostID: hostID, AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}
	tlsMaterial, clientTLS := publishedSyntheticTLS(t)
	endpoint := domain.ManagedEndpoint{ID: "second-managed-entry", InstanceID: instance.ID, Name: "Second public TLS entry", Authentication: "principals", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: port, TLS: &domain.TLSOptions{Enabled: true, ServerName: clientTLS.ServerName}}}
	post("core-instances", instance)
	post("managed-endpoints", endpoint)
	deployment := httpapi.ServerDeployment{ID: "second-managed-deployment", Name: "Second managed deployment", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", TopologyRevision: "policy2", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint, TLS: tlsMaterial, DestinationPolicy: &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}}}}}
	post("server-deployments", deployment)
	post("published-routes", map[string]any{"id": "second-published-route", "name": "Second direct route", "deploymentId": deployment.ID, "endpointIds": []string{endpoint.ID}, "publicHost": clientTLS.ServerName, "publicPort": port})
	originalPlan := plan
	plan.RouteIDs = append(append([]string(nil), plan.RouteIDs...), "second-published-route")
	post("services", plan)
	post("published-routes/second-published-route/principals", map[string]any{"accountId": user.id, "entryId": "second-account-entry", "credentialVersion": "v1"})
	enrollment := post("agent/enrollments", map[string]any{"nodeId": hostID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
	var scope agent.Scope
	raw, _ := json.Marshal(enrollment["scope"])
	json.Unmarshal(raw, &scope)
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: baseURL, Token: enrollment["token"].(string), Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	opened := openServerDraft(t, admin, baseURL+"/api/server-deployments/"+deployment.ID)
	validation := requireServerValidation(t, admin, baseURL+"/api/server-deployments/"+deployment.ID, opened["revisionToken"].(string))
	publication := post("server-deployments/"+deployment.ID+"/publish", map[string]any{"operationId": "publish-native", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": validation["fingerprint"]})
	if publication["status"] != "publication-accepted" || publication["nativeChecked"] != false {
		t.Fatalf("publication not accepted: %v", publication)
	}
	desired, err := transport.ReceiveDesired(context.Background(), scope, 0)
	if err != nil || desired == nil {
		t.Fatalf("second entry desired %v %v", desired, err)
	}
	state := runPublishedNativeTarget(t, *desired, transport)
	if err = transport.ReportObservation(context.Background(), scope, state); err != nil {
		t.Fatal(err)
	}
	code, out, rawText := req(t, admin, "GET", baseURL+"/api/users/"+user.id+"/entries/second-account-entry/reveal", "", nil)
	if code != 200 {
		t.Fatalf("second effective entry %d %s", code, rawText)
	}
	if strings.Contains(rawText, "PRIVATE KEY") || strings.Contains(rawText, tlsMaterial.PrivateKeyPEM) {
		t.Fatal("public TLS entry leaked server private material")
	}
	if out["connection"].(map[string]any)["host"] != clientTLS.ServerName {
		t.Fatal("public TLS address was not preserved")
	}
	if untrusted, err := dialPublishedEntry(port, &tls.Config{ServerName: clientTLS.ServerName, MinVersion: tls.VersionTLS13}); err == nil {
		untrusted.Close()
		t.Fatal("synthetic server TLS accepted without scoped CA trust")
	}
	secondUUID := out["connection"].(map[string]any)["uuid"].(string)
	provePublishedPrincipalTraffic(t, port, secondUUID, clientTLS)
	const settledBefore = int64(len("published-admitted-payload") * 4)
	awaitPublishedUsage(t, user, baseURL, settledBefore, settledBefore)
	awaitPublishedBudgetsClosed(t, admin, baseURL, "second-managed-core")
	const allowance = 4096
	plan.QuotaBytes = settledBefore + allowance
	post("services", plan)
	defer post("services", originalPlan)
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var targetBytes, clientBytes atomic.Int64
	var serving sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			serving.Add(1)
			go func() {
				defer serving.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(4 * time.Second))
				buffer := make([]byte, 1024)
				for {
					n, err := conn.Read(buffer)
					if n > 0 {
						targetBytes.Add(int64(n))
						if _, writeErr := conn.Write(buffer[:n]); writeErr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	targetPort := echo.Addr().(*net.TCPAddr).Port
	var flows sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 8; i++ {
		flows.Add(1)
		go func(index int) {
			defer flows.Done()
			<-start
			entryPort, uuid := primaryPort, primaryUUID
			var wireTLS *tls.Config
			if index%2 == 1 {
				entryPort, uuid, wireTLS = port, secondUUID, clientTLS
			}
			conn, err := dialPublishedEntry(entryPort, wireTLS)
			if err != nil {
				return
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(4 * time.Second))
			credential, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
			header := append([]byte{0}, credential...)
			header = append(header, 0, 1, byte(targetPort>>8), byte(targetPort), 1, 127, 0, 0, 1)
			header = append(header, bytes.Repeat([]byte("b"), 128<<10)...)
			if _, err = conn.Write(header); err != nil {
				return
			}
			response := make([]byte, 2)
			if _, err = io.ReadFull(conn, response); err != nil {
				return
			}
			if response[0] != 0 || response[1] != 0 {
				return
			}
			n, _ := io.Copy(io.Discard, conn)
			clientBytes.Add(n)
		}(i)
	}
	close(start)
	flows.Wait()
	echo.Close()
	<-acceptDone
	serving.Wait()
	transferred := targetBytes.Load() + clientBytes.Load()
	if transferred <= 0 || transferred > allowance {
		_, _, evidence := req(t, user.c, "GET", baseURL+"/api/me/overview", "", nil)
		t.Fatalf("shared native finite budget exceeded or carried no payload: upstream=%d downstream=%d allowance=%d ledger=%s", targetBytes.Load(), clientBytes.Load(), allowance, evidence)
	}
	awaitPublishedUsage(t, user, baseURL, settledBefore+allowance, settledBefore+allowance)
	code, out, rawText = req(t, user.c, "GET", baseURL+"/api/me/overview", "", nil)
	if code != 200 || out["status"] != "exhausted" {
		t.Fatalf("quota exhaustion not reflected in same ledger %d %s", code, rawText)
	}
}
func awaitPublishedUsage(t *testing.T, user sessionClient, baseURL string, rawBytes, weightedBytes int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, out, raw := req(t, user.c, "GET", baseURL+"/api/me/overview", "", nil)
		if code != 200 {
			t.Fatalf("settled overview %d %s", code, raw)
		}
		usage := out["usage"].(map[string]any)
		if usage["rawBytes"] == float64(rawBytes) && usage["weightedBytes"] == float64(weightedBytes) && out["accountingPending"] == false {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("native byte settlement mismatch want %d/%d: %s", rawBytes, weightedBytes, raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func awaitPublishedBudgetsClosed(t *testing.T, admin *http.Client, baseURL, instanceID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, _, raw := req(t, admin, "GET", baseURL+"/api/agent/instances/"+instanceID+"/admission-budgets", "", nil)
		var budgets []struct {
			Closed bool `json:"closed"`
		}
		if code != 200 || json.Unmarshal([]byte(raw), &budgets) != nil {
			t.Fatalf("inspect final native settlements: %d %s", code, raw)
		}
		closed := len(budgets) > 0
		for _, budget := range budgets {
			closed = closed && budget.Closed
		}
		if closed {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("native presence did not finalize: %s", raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
