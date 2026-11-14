package httpapi_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func openMigrationNativeTarget(t *testing.T, desired agent.Desired, transport *agent.HTTPTransport) (*agent.Reconciler, agent.State) {
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
	return reconciler, state
}
func TestNativePrincipalMigrationAndCompensation(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN") == "" || os.Getenv("ROUTEWEAVER_CORE_BIN_DIR") == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("explicit local native runtime opt-in required")
	}
	entryPort, transitPort := publishedFreePort(t), publishedFreePort(t)
	f := newRotationRecoveryFixtureAtPorts(t, entryPort, transitPort)
	httpapi.SetLegacyWildcardMigrationFixtureForTest(t, f.s)
	input := map[string]any{"action": "configure", "deploymentId": "rotation-path", "targetIds": []string{"rotation-core", "rotation-transit"}, "continuousService": true}
	plan := f.postAdmin("admin/fleet-batches/preview", input)
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 30
	batch := f.postAdmin("admin/fleet-batches", input)
	f.postAdmin("admin/fleet-batches/"+batch["id"].(string)+"/execute", map[string]any{"stage": 0, "requestId": "native-baseline"})
	httpapi.AssertLegacyMigrationAuthorityForTest(t, f.s)
	httpapi.PersistLegacyMigrationAuthorityForTest(t, f.s)
	live := map[string]*agent.Reconciler{}
	var original httpapi.PublicEntryGrant
	if err := f.s.TenantGet(f.owner.id, "platform-entries", "rotation-grant", &original); err != nil {
		t.Fatal(err)
	}
	apply := func(stage string) {
		// Transit first, then the ingress; both use the same persistent reconcilers.
		for _, index := range []int{1, 0} {
			scope := f.scopes[index]
			transport := f.agents[index]
			var desired controlprotocol.Desired
			if err := f.s.Get("agent-desired", scope.InstanceID, &desired); err != nil {
				t.Fatal(err)
			}
			var state agent.State
			if live[scope.InstanceID] == nil {
				reconciler, current := openMigrationNativeTarget(t, desired, transport)
				live[scope.InstanceID] = reconciler
				state = current
			} else {
				var err error
				state, err = live[scope.InstanceID].Submit(context.Background(), desired)
				if err != nil || state.Phase != agent.ObservedConformant {
					t.Fatalf("native %s apply %s: phase=%s err=%v", stage, scope.InstanceID, state.Phase, err)
				}
			}
			state, reportErr := live[scope.InstanceID].ObservationReport()
			if reportErr != nil {
				t.Fatal(reportErr)
			}
			if err := transport.ReportObservation(context.Background(), scope, state); err != nil {
				t.Fatal(err)
			}
		}
		provePublishedPrincipalTraffic(t, entryPort, original.Connection.UUID, nil)
		awaitPublishedBudgetsClosed(t, f.admin, f.srv.URL, "rotation-core")
		if stage == "compensated" {
			assertCompensatedPrincipalRejected(t, entryPort)
		}
		if stage == "migrated" {
			provePublishedPrincipalTraffic(t, entryPort, "22222222-2222-4222-8222-222222222222", nil)
			awaitPublishedBudgetsClosed(t, f.admin, f.srv.URL, "rotation-core")
			deadline := time.Now().Add(3 * time.Second)
			for {
				records, err := f.s.List("ledger")
				if err != nil {
					t.Fatal(err)
				}
				var attributed int64
				for _, raw := range records {
					var record store.MeterRecord
					if json.Unmarshal(raw, &record) == nil && record.OutputID == "new-output" && record.OutputRevision == "output-v1" {
						attributed += record.RawBytes
					}
				}
				if attributed == int64(len("published-admitted-payload")*2) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("new principal real traffic attribution=%d", attributed)
				}
				time.Sleep(20 * time.Millisecond)
			}

		}
		if stage == "baseline" || stage == "migrated" {
			// Exercise legacy persisted authority and newly migrated generations. No
			// forged lease timestamps: wait for the actual 30-second lease window.
			var d controlprotocol.Desired
			f.s.Get("agent-desired", "rotation-core", &d)
			if delay := time.Until(d.Lease.IssuedAt.Add(21 * time.Second)); delay > 0 {
				time.Sleep(delay)
			}
			for _, index := range []int{1, 0} {
				id := f.scopes[index].InstanceID
				fact, err := live[id].ServiceHeartbeat(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				response, err := f.agents[index].SendServiceHeartbeat(context.Background(), fact)
				if err != nil || response.PolicyRefresh == nil {
					t.Fatalf("migrated continuous renewal %s: %v, %+v", id, err, response)
				}
				if _, err = live[id].ApplyPolicyRefresh(context.Background(), *response.PolicyRefresh); err != nil {
					t.Fatal(err)
				}
			}
			time.Sleep(5100 * time.Millisecond)
			for _, index := range []int{1, 0} {
				id := f.scopes[index].InstanceID
				fact, err := live[id].ServiceHeartbeat(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.agents[index].SendServiceHeartbeat(context.Background(), fact); err != nil {
					t.Fatal(err)
				}
				state, err := live[id].ObservationReport()
				if err != nil {
					t.Fatal(err)
				}
				if err = f.agents[index].ReportObservation(context.Background(), f.scopes[index], state); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	httpapi.QueuePrincipalMigrationForTest(t, f.s, f.owner.id, apply)
	t.Log("native configure migration and precise compensation preserve legacy credential; new principal real bytes carry immutable output attribution")
}

func assertCompensatedPrincipalRejected(t *testing.T, entryPort int) {
	t.Helper()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	conn, err := dialPublishedEntry(entryPort, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	credential, _ := hex.DecodeString("22222222222242228222222222222222")
	port := echo.Addr().(*net.TCPAddr).Port
	header := append([]byte{0}, credential...)
	header = append(header, 0, 1, byte(port>>8), byte(port), 1, 127, 0, 0, 1)
	header = append(header, []byte("must-be-rejected")...)
	if _, err = conn.Write(header); err != nil {
		return
	}
	response := make([]byte, 2)
	if _, err = io.ReadFull(conn, response); err == nil {
		t.Fatal("compensated principal still authenticated")
	}
}
