package httpapi_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Required by scripts/managed-runtime.sh. A skip is not native-service evidence.
func managedObservationSeconds(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 30 || seconds > 1800 {
		return 0, fmt.Errorf("ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS must be 30..1800")
	}
	return seconds, nil
}

func TestManagedObservationWindowBounds(t *testing.T) {
	for _, raw := range []string{"-1", "0", "29", "1801", "bad"} {
		if _, err := managedObservationSeconds(raw); err == nil {
			t.Fatalf("accepted invalid window %q", raw)
		}
	}
	for _, raw := range []string{"", "30", "120", "1800"} {
		if _, err := managedObservationSeconds(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNativeContinuousManagedServicePreservesPayloadAndRevocation(t *testing.T) {
	testNativeContinuousManagedService(t, false, false)
}
func TestNativeManagedOperationalRecovery(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_OPERATIONAL_DRILL") != "1" {
		t.Skip("explicit local operational drill opt-in required")
	}
	testNativeContinuousManagedService(t, true, false)
}
func testNativeContinuousManagedService(t *testing.T, operationalDrill, providerDrill bool) {
	observationSeconds, err := managedObservationSeconds(os.Getenv("ROUTEWEAVER_MANAGED_OBSERVATION_SECONDS"))
	if err != nil {
		t.Fatal(err)
	}

	binary := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	if binary == "" {
		t.Skip("explicit managed native executable required")
	}
	f, user, port := managedServiceFixture(t)
	f, _, token, d := continuousFixtureFrom(t, f)
	ageContinuousLease(t, f, &d)
	d.Lease.IssuedAt = time.Now().UTC().Add(-285 * time.Second)
	d.Lease.ExpiresAt = d.Lease.IssuedAt.Add(300 * time.Second)
	if err := f.s.Put("agent-desired", d.InstanceID, d); err != nil {
		t.Fatal(err)
	}
	var intent map[string]any
	if err := f.s.Get("agent-service-intents", d.InstanceID, &intent); err != nil {
		t.Fatal(err)
	}
	intent["lease"] = d.Lease
	intent["validationNotBefore"] = time.Now().UTC().Add(time.Second)
	if err := f.s.Put("agent-service-intents", d.InstanceID, intent); err != nil {
		t.Fatal(err)
	}
	var manifest domain.PublishedManifest
	if err := f.s.Get("published-manifests", d.RevisionID, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.PolicyExpiresAt = d.Lease.ExpiresAt
	if err := f.s.Put("published-manifests", d.RevisionID, manifest); err != nil {
		t.Fatal(err)
	}

	root, err := os.MkdirTemp("", "rw-service-native-")
	if err != nil {
		t.Fatal(err)
	}
	retain := false
	t.Cleanup(func() {
		if !retain {
			os.RemoveAll(root)
		}
	})
	contents, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary = filepath.Join(root, "managed-core")
	if err = os.WriteFile(binary, contents, 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := agent.NewNativeChecker(d.AdapterID, d.CoreVersion, binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	reconciler, err := agent.Open(root, d.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	spool, err := agent.OpenMeterSpool(filepath.Join(root, "meters"), d.Scope, "native-service-test")
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := newReferenceDiagnostics(t, f, referenceDiagnosticsEnabled(observationSeconds, operationalDrill, providerDrill), !operationalDrill)
	t.Cleanup(func() {
		if timeline := diagnostics.failureTimeline(t.Failed()); len(timeline) > 0 {
			t.Logf("redacted native failure timeline initial_issued_at=%s initial_expires_at=%s: %s", d.Lease.IssuedAt.Format(time.RFC3339Nano), d.Lease.ExpiresAt.Format(time.RFC3339Nano), timeline)
		}
		if diagnostics.enabled && t.Failed() {
			retain = true
			if err := diagnostics.Preserve(root); err != nil {
				t.Errorf("reference diagnostic preservation error_type=%s", referenceErrorType(err))
			}
			t.Logf("private failure evidence retained: %s", root)
		}
	})
	transportURL, operationalGate := operationalTransport(t, f, operationalDrill)
	if diagnostics.recording {
		transportURL = diagnostics.URL
	}
	transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: transportURL, Scope: d.Scope, Token: token, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	var cancel context.CancelFunc
	var done chan error
	var outageErrors atomic.Int64
	var operationalEpoch string
	var referenceEpoch string
	startDriver := func() {
		ctx, stop := context.WithCancel(context.Background())
		cancel = stop
		done = make(chan error, 1)
		currentReconciler, currentSpool, result := reconciler, spool, done
		go func() {
			_, err := agent.RunDriver(ctx, currentReconciler, transport, currentSpool, agent.DriverOptions{Continuous: true, PollInterval: 50 * time.Millisecond, LeaseInterval: 50 * time.Millisecond, OnTransportError: func(err error) {
				diagnostics.Record("driver_transport", err)
				if operationalExpectedOutage(err) {
					outageErrors.Add(1)
				}
			}})
			diagnostics.Record("driver_exit", err)
			result <- err
		}()
	}
	stopForRecovery := func() {
		before := outageErrors.Load()
		cancel()
		select {
		case err := <-done:
			done = nil
			if err != nil {
				t.Fatalf("operator stop failed: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("operator stop did not drain owned driver")
		}
		if outageErrors.Load() <= before {
			t.Fatal("shutdown did not expose typed HTTP503 delivery failure")
		}
		if !operationalStoppedState(reconciler.State()) {
			t.Fatalf("operator stop is not conclusive: %+v", reconciler.State())
		}
	}
	restartAfterRecovery := func() *agent.Reconciler {
		if done != nil {
			t.Fatal("cannot reopen state while driver owns it")
		}
		if err := spool.Close(); err != nil {
			t.Fatal(err)
		}
		if err := reconciler.Close(); err != nil {
			t.Fatal(err)
		}
		reopenedReconciler, openErr := agent.Open(root, d.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: 10 * time.Minute})
		if openErr != nil {
			t.Fatal(openErr)
		}
		reconciler = reopenedReconciler
		reopenedSpool, openErr := agent.OpenMeterSpool(filepath.Join(root, "meters"), d.Scope, "native-service-test")
		if openErr != nil {
			t.Fatal(openErr)
		}
		spool = reopenedSpool
		startDriver()
		return reconciler
	}
	startDriver()
	t.Cleanup(func() {
		diagnostics.SetPhase("cleanup")
		cancel()
		driverStopped := done == nil
		if done != nil {
			select {
			case err := <-done:
				driverStopped = true
				if err != nil {
					retain = true
					t.Errorf("native service cleanup: %v; evidence %s", err, root)
				}
			case <-time.After(10 * time.Second):
				retain = true
				t.Errorf("native service shutdown timeout; evidence %s", root)
			}
		}
		if diagnostics.enabled && driverStopped {
			checkReferenceTerminal(t, f, supervisor, reconciler, spool, root, d.Scope, referenceEpoch)
		}
		if operationalDrill && driverStopped {
			checkOperationalTerminal(t, f, supervisor, spool, root, d.Scope, operationalEpoch, user.id)
		}
		if driverStopped {
			if err := spool.Close(); err != nil {
				retain = true
				t.Errorf("meter spool close: %v; evidence %s", err, root)
			}
			if err := reconciler.Close(); err != nil {
				retain = true
				t.Errorf("reconciler close: %v; evidence %s", err, root)
			}
		}
		transport.Close()
		if t.Failed() {
			retain = true
			if operationalDrill {
				preserveOperationalFailure(t, f.databasePath, root)
			}
		}
		if operationalDrill {
			t.Logf("operational cleanup: driver_returned=%t checked_spool_and_reconciler_close=%t evidence_retained=%t", driverStopped, driverStopped, retain)
		}
	})
	deadline := time.Now().Add(8 * time.Second)
	for {
		fact, e := reconciler.ServiceHeartbeat(context.Background())
		var reported agent.State
		f.s.Get("agent-observations", d.InstanceID, &reported)
		if e == nil && fact.Observed.Identity == d.Identity() && reported.Observed != nil && reported.Observed.Identity == d.Identity() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native continuous driver did not activate original identity")
		}
		time.Sleep(20 * time.Millisecond)
	}
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	uuid := "00000000-0000-4000-8000-000000000011"
	dial := func() (net.Conn, error) {
		c, e := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
		if e != nil {
			return nil, e
		}
		c.SetDeadline(time.Now().Add(2 * time.Second))
		credential, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
		target := echo.Addr().(*net.TCPAddr).Port
		header := append([]byte{0}, credential...)
		header = append(header, 0, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1)
		header = append(header, []byte("before-renewal")...)
		if _, e = c.Write(header); e != nil {
			c.Close()
			return nil, e
		}
		got := make([]byte, 2+len("before-renewal"))
		_, e = io.ReadFull(c, got)
		if e != nil {
			c.Close()
			return nil, e
		}
		if string(got[2:]) != "before-renewal" {
			c.Close()
			return nil, errors.New("native payload mismatch")
		}
		return c, nil
	}
	conn, err := dial()
	if err != nil {
		t.Fatal("real managed admission failed:", err)
	}
	defer conn.Close()
	// The flow exists before the independent instance refresh, and must retain
	// only its own bounded admission authority throughout renewal.
	fact, err := reconciler.ServiceHeartbeat(context.Background())
	if err != nil || fact.PolicyIssuedAt != d.Lease.IssuedAt {
		t.Fatal("flow was not opened before instance refresh", err)
	}
	deadline = time.Now().Add(8 * time.Second)
	for {
		fact, err = reconciler.ServiceHeartbeat(context.Background())
		if err == nil && fact.PolicyIssuedAt.After(d.Lease.IssuedAt) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native continuous driver did not apply refresh")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if wait := time.Until(d.Lease.ExpiresAt.Add(200 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	payload := []byte("after-original-instance-lease")
	if _, err = conn.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if n, readErr := io.ReadFull(conn, got); readErr != nil || string(got) != string(payload) {
		diagnostics.Payload(0, n, "read", 0, readErr)
		t.Fatalf("payload did not cross original instance expiry: %q %v", got, readErr)
	}
	obs, err := supervisor.Observe(context.Background(), root)
	if err != nil || obs.Identity != d.Identity() {
		t.Fatal("instance renewal replaced native identity")
	}
	if operationalGate != nil {
		snapshot, snapshotErr := agent.ReadManagedSnapshot(context.Background(), root)
		if snapshotErr != nil {
			t.Fatal(snapshotErr)
		}
		operationalEpoch = snapshot.CounterEpoch
		conn, d, operationalEpoch = runManagedOperationalDrill(t, f, conn, operationalGate, d, user.id, supervisor, reconciler, root, dial, stopForRecovery, restartAfterRecovery)
		defer conn.Close()
	}
	if diagnostics.enabled {
		snapshot, snapshotErr := agent.ReadManagedSnapshot(context.Background(), root)
		if snapshotErr != nil {
			t.Fatal("reference epoch observation failed")
		}
		referenceEpoch = snapshot.CounterEpoch
	}
	if providerDrill {
		conn = runNativeProviderSuspension(t, f, conn, d, user.id, supervisor, root, dial)
		defer conn.Close()
	}
	// Explicit bounded reference observation; default CI retains the original test.
	// This does not turn synthetic loopback traffic into a production capacity SLA.
	if seconds := observationSeconds; seconds != 0 {
		diagnostics.SetPhase("observation")
		started := time.Now()
		maxRTT := time.Duration(0)
		var initialRootBytes int64
		for sample := 0; sample < seconds; sample++ {
			if wait := time.Until(started.Add(time.Duration(sample) * time.Second)); wait > 0 {
				time.Sleep(wait)
			}
			tick := time.Now()
			conn.SetDeadline(tick.Add(2 * time.Second))
			lag := tick.Sub(started.Add(time.Duration(sample) * time.Second))
			if n, writeErr := conn.Write(payload); writeErr != nil {
				diagnostics.Payload(sample, n, "write", lag, writeErr)
				if stackErr := diagnostics.CaptureStacks(root); stackErr != nil {
					t.Logf("private failure stacks unavailable error_type=%s", referenceErrorType(stackErr))
				}
				t.Fatalf("reference payload write sample=%d n=%d scheduler_lag=%s error_type=%s", sample, n, lag, referenceErrorType(writeErr))
			}
			n, readErr := io.ReadFull(conn, got)
			diagnostics.Payload(sample, n, "read", lag, readErr)
			if readErr != nil || string(got) != string(payload) {
				if stackErr := diagnostics.CaptureStacks(root); stackErr != nil {
					t.Logf("private failure stacks unavailable error_type=%s", referenceErrorType(stackErr))
				}
				t.Fatalf("reference payload read sample=%d n=%d scheduler_lag=%s elapsed=%s mismatch=%t error_type=%s", sample, n, lag, time.Since(tick), string(got[:n]) != string(payload), referenceErrorType(readErr))
			}
			if rtt := time.Since(tick); rtt > maxRTT {
				maxRTT = rtt
			}
			heartbeat, heartbeatErr := reconciler.ServiceHeartbeat(context.Background())
			if heartbeatErr != nil || !heartbeat.ServiceActive || !heartbeat.PolicyIssuedAt.After(d.Lease.IssuedAt) {
				t.Fatalf("reference service/renewal unavailable at sample %d: %v", sample, heartbeatErr)
			}
			if sample%30 == 0 {
				var memory runtime.MemStats
				runtime.ReadMemStats(&memory)
				var bytes int64
				if walkErr := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
					if err != nil {
						return err
					}
					if info.Mode().IsRegular() {
						bytes += info.Size()
					}
					return nil
				}); walkErr != nil {
					t.Fatal(walkErr)
				}
				if sample == 0 {
					initialRootBytes = bytes
				}
				// Synthetic-reference guardrails, not production operating limits.
				if memory.HeapAlloc > 128<<20 || bytes-initialRootBytes > 16<<20 {
					t.Fatalf("reference growth guardrail exceeded: parent heap=%d agent root growth=%d", memory.HeapAlloc, bytes-initialRootBytes)
				}
				var databaseBytes [3]int64
				for i, suffix := range []string{"", "-wal", "-shm"} {
					info, statErr := os.Stat(f.databasePath + suffix)
					if statErr == nil {
						databaseBytes[i] = info.Size()
					} else if !os.IsNotExist(statErr) {
						databaseBytes[i] = -1
					}
				}
				// Observation-only public persistence seam: aggregate counts/bytes, never values.
				for _, kind := range []string{"meter-inbox", "meter-receipts", "meter-streams", "meter-pending", "ledger", "admission-budgets", "entry-admission-leases", "agent-desired", "agent-observations"} {
					records, listErr := f.s.List(kind)
					if listErr != nil {
						t.Fatal(listErr)
					}
					var payloadBytes int
					for _, record := range records {
						payloadBytes += len(record)
					}
					t.Logf("reference records sample=%d kind=%s rows=%d logical_json_bytes=%d", sample, kind, len(records), payloadBytes)
				}

				// Existing bounded public inventory: metrics only, no plaintext row listing.
				capacityCtx, capacityCancel := context.WithTimeout(context.Background(), time.Second)
				capacity, capacityErr := f.s.HistoryCapacityInventory(capacityCtx, store.BackupLimits{MaxBytes: 1 << 30, MaxRows: 2000000, MaxRecordBytes: 32 << 20})
				capacityCancel()
				if capacityErr != nil {
					t.Logf("reference history sample=%d inventory_known=false", sample)
				} else {
					t.Logf("reference history sample=%d inventory_known=true ledger_rows=%d ledger_at_least=%t backup_rows=%d backup_rows_at_least=%t", sample, capacity.NotificationLedgerRows.Count, capacity.NotificationLedgerRows.AtLeast, capacity.BackupRows.Count, capacity.BackupRows.AtLeast)
				}
				nativeRSS, nativeFDs, nativeKnown := referenceOwnedProcessMetrics(root)
				t.Logf("reference storage/process sample=%d cp_db_bytes=%d cp_wal_bytes=%d cp_shm_bytes=%d native_metrics_known=%t native_rss_kib=%d native_fds=%d", sample, databaseBytes[0], databaseBytes[1], databaseBytes[2], nativeKnown, nativeRSS, nativeFDs)
				t.Logf("reference progress sample=%d parent_Go_heap_bytes=%d agent_root_bytes=%d policy_issued=%s max_RTT=%s", sample, memory.HeapAlloc, bytes, heartbeat.PolicyIssuedAt, maxRTT)
			}
			observed, observeErr := supervisor.Observe(context.Background(), root)
			if observeErr != nil || observed.Identity != d.Identity() {
				t.Fatalf("reference native identity changed at sample %d: %v", sample, observeErr)
			}
		}
		if wait := time.Until(started.Add(time.Duration(seconds) * time.Second)); wait > 0 {
			time.Sleep(wait)
		}
		t.Logf("reference managed payload: samples=%d duration=%s max_RTT=%s; identity unchanged; synthetic single flow, not capacity SLA", seconds, time.Since(started), maxRTT)
	}
	diagnostics.SetPhase("revoke")
	if code, _, raw := req(t, operatorClient(), "DELETE", f.srv.URL+"/api/users/"+user.id+"/entries/alice-entry", "", nil); code != 200 {
		t.Fatal(code, raw)
	}
	// The refreshed instance lease must not authorize this revoked principal.
	if denied, e := dial(); e == nil {
		denied.Close()
		t.Fatal("revoked principal obtained a new native flow")
	}
	deadline = time.Now().Add(entrypolicy.MaxLease + 3*time.Second)
	closed := false
	for time.Now().Before(deadline) {
		conn.SetDeadline(time.Now().Add(time.Second))
		_, e := conn.Write([]byte("x"))
		if e == nil {
			var b [1]byte
			_, e = io.ReadFull(conn, b[:])
		}
		if e != nil {
			if timeout, ok := e.(net.Error); !ok || !timeout.Timeout() {
				closed = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !closed {
		t.Fatal("existing revoked flow outlived its own bounded admission lease")
	}
	obs, err = supervisor.Observe(context.Background(), root)
	if err != nil || obs.Identity != d.Identity() {
		t.Fatal("revocation test only passed because whole runtime exited")
	}
}

// Metrics only: read the fixture's owned-process receipt, not the host process list.
// Unknown or changed ownership discards the sample; never signal or inspect another PID.
func referenceOwnedProcessMetrics(root string) (rssKiB int64, fds int, known bool) {
	var record struct {
		PID        int    `json:"pid"`
		StartTicks string `json:"startTicks"`
		Executable string `json:"executable"`
		Pending    bool   `json:"pending"`
		Absent     bool   `json:"absent"`
	}
	raw, err := os.ReadFile(filepath.Join(root, "owned-process.json"))
	if err != nil || json.Unmarshal(raw, &record) != nil || record.PID <= 1 || record.Pending || record.Absent || record.Executable != filepath.Join(root, "managed-core") {
		return -1, -1, false
	}
	proc := filepath.Join("/proc", strconv.Itoa(record.PID))
	matches := func() bool {
		exe, err := os.Readlink(filepath.Join(proc, "exe"))
		if err != nil || exe != record.Executable {
			return false
		}
		stat, err := os.ReadFile(filepath.Join(proc, "stat"))
		if err != nil {
			return false
		}
		end := strings.LastIndexByte(string(stat), ')')
		if end < 0 {
			return false
		}
		fields := strings.Fields(string(stat[end+1:]))
		return len(fields) >= 20 && fields[19] == record.StartTicks && fields[0] != "Z" && fields[0] != "X"
	}
	if !matches() {
		return -1, -1, false
	}
	status, err := os.ReadFile(filepath.Join(proc, "status"))
	if err != nil {
		return -1, -1, false
	}
	entries, err := os.ReadDir(filepath.Join(proc, "fd"))
	if err != nil {
		return -1, -1, false
	}
	rssKiB = -1
	for _, line := range strings.Split(string(status), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "VmRSS:" && fields[2] == "kB" {
			rssKiB, err = strconv.ParseInt(fields[1], 10, 64)
			if err != nil {
				return -1, -1, false
			}
		}
	}
	if rssKiB < 0 || !matches() {
		return -1, -1, false
	}
	return rssKiB, len(entries), true
}

func TestReferenceOwnedProcessMetricsMissingReceiptIsUnknown(t *testing.T) {
	rss, fds, known := referenceOwnedProcessMetrics(t.TempDir())
	if known || rss != -1 || fds != -1 {
		t.Fatal("missing owned receipt fabricated process metrics")
	}
}
