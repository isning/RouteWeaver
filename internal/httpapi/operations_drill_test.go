package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"routeweaver/internal/agent"
	"routeweaver/internal/backup"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type operationalDelivery struct {
	fail   bool
	events []string
}

func (d *operationalDelivery) Send(_ context.Context, _ string, event notifications.Event, _ notifications.Settings, _ notifications.Secrets) error {
	d.events = append(d.events, event.EventID)
	if d.fail {
		return errors.New("synthetic private-password transport failure")
	}
	return nil
}

func TestOperationalNotificationFailureVisibleAndRetry(t *testing.T) {
	s, srv := makeServer(t)
	delivery := &operationalDelivery{fail: true}
	service := notifications.New(s, delivery)
	view, err := service.Settings()
	if err != nil {
		t.Fatal(err)
	}
	view.Webhook = notifications.WebhookSettings{Enabled: true, URL: "https://synthetic.example.test/events"}
	secret := "synthetic-operational-signing-key"
	if _, err = service.SaveSettings(notifications.SettingsInput{Settings: view.Settings, WebhookSecret: &secret}); err != nil {
		t.Fatal(err)
	}
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	now := time.Now().UTC()
	id, err := service.Test("webhook", admin, now)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err = service.Dispatch(context.Background(), []notifications.Recipient{admin}, now); err != nil {
		t.Fatal(err)
	}
	read := func() notifications.OutboxItem {
		code, raw := adminNotificationRequest(t, srv.URL+"/api/admin/notifications/outbox", "GET", nil)
		var items []notifications.OutboxItem
		if code != 200 || json.Unmarshal(raw, &items) != nil || len(items) != 1 || strings.Contains(string(raw), "private-password") || strings.Contains(string(raw), secret) {
			t.Fatalf("outbox missing or leaked unsanitized failure: status=%d", code)
		}
		return items[0]
	}
	failed := read()
	if failed.EventID != id || failed.Status != "retrying" || failed.Attempts != 1 || failed.LastError == "" {
		t.Fatalf("failure not visible: %+v", failed)
	}
	visible := time.Since(started)
	service = notifications.New(s, delivery) // New worker, same durable outbox; physical reopen has separate coverage.
	delivery.fail = false
	retryStarted := time.Now()
	if err = service.Dispatch(context.Background(), []notifications.Recipient{admin}, failed.NextAttemptAt); err != nil {
		t.Fatal(err)
	}
	accepted := read()
	if accepted.Status != "accepted" || accepted.Attempts != 2 || accepted.EventID != id {
		t.Fatalf("retry not visible: %+v", accepted)
	}
	if err = service.Dispatch(context.Background(), []notifications.Recipient{admin}, failed.NextAttemptAt.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(delivery.events) != 2 || delivery.events[0] != delivery.events[1] {
		t.Fatal("retry duplicated stable identity or resent accepted event")
	}
	t.Logf("notification failure visible=%s retry-to-accepted=%s scheduled-delay=%s (clock advanced; no real provider)", visible, time.Since(retryStarted), failed.NextAttemptAt.Sub(now))
}

type operationalConnectionGate struct {
	mu           sync.RWMutex
	disconnected bool
	blockedFinal atomic.Int64
}

// Drains admitted fixture requests before changing connectivity, without sleeps.
func (g *operationalConnectionGate) Store(disconnected bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.disconnected = disconnected
}

func operationalTransport(t *testing.T, f fleetFixture, enabled bool) (string, *operationalConnectionGate) {
	t.Helper()
	if !enabled {
		return f.srv.URL, nil
	}
	gate := &operationalConnectionGate{}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gate.mu.RLock()
		defer gate.mu.RUnlock()
		if gate.disconnected {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/admission-leases") {
				var request entrypolicy.AdmissionRequest
				if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&request) == nil && request.Final {
					gate.blockedFinal.Add(1)
				}
			}
			http.Error(w, "synthetic CP unavailable", http.StatusServiceUnavailable)
			return
		}
		f.srv.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(proxy.Close)
	return proxy.URL, gate
}

func runManagedOperationalDrill(t *testing.T, f fleetFixture, conn net.Conn, gate *operationalConnectionGate, d controlprotocol.Desired, userID string, supervisor *agent.ProcessSupervisor, reconciler *agent.Reconciler, root string, dial func() (net.Conn, error), stopDriver func(), restartDriver func() *agent.Reconciler) (net.Conn, controlprotocol.Desired, string) {
	t.Helper()
	roundTrip := func() error {
		payload := []byte("operational-backup-payload")
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write(payload); err != nil {
			return err
		}
		got := make([]byte, len(payload))
		if _, err := io.ReadFull(conn, got); err != nil {
			return err
		}
		if !bytes.Equal(got, payload) {
			return errors.New("operational payload mismatch")
		}
		return nil
	}
	outageStarted := time.Now()
	gate.Store(true)
	defer gate.Store(false)
	var before, after agent.State
	if err := f.s.Get("agent-observations", d.InstanceID, &before); err != nil || before.Observed == nil {
		t.Fatal("missing last observation", err)
	}
	time.Sleep(250 * time.Millisecond)
	if err := f.s.Get("agent-observations", d.InstanceID, &after); err != nil || after.Observed == nil {
		t.Fatal("lost retained observation", err)
	}
	if !after.Observed.ObservedAt.Equal(before.Observed.ObservedAt) {
		t.Fatal("disconnected CP fabricated a fresh observation")
	}
	if err := roundTrip(); err != nil {
		t.Fatal("existing bounded admission lost during short outage", err)
	}
	outageDuration := time.Since(outageStarted)
	began := time.Now()
	gate.Store(false)
	deadline := began.Add(3 * time.Second)
	for {
		if err := f.s.Get("agent-observations", d.InstanceID, &after); err != nil {
			t.Fatal(err)
		}
		if after.Observed != nil && after.Observed.ObservedAt.After(before.Observed.ObservedAt) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("CP reconnect never refreshed observation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Logf("operational disconnect: HTTP503 window=%s retained last observation, reconnect refresh=%s; not long-outage expiry proof", outageDuration, time.Since(began))

	var count atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	trafficDone := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				trafficDone <- nil
				return
			default:
			}
			if err := roundTrip(); err != nil {
				trafficDone <- err
				return
			}
			count.Add(1)
			time.Sleep(5 * time.Millisecond)
		}
	}()
	joined := false
	defer func() {
		if !joined {
			cancel()
			<-trafficDone
		}
	}()
	deadline = time.Now().Add(2 * time.Second)
	for count.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("payload worker did not start")
		}
		time.Sleep(time.Millisecond)
	}
	var encrypted bytes.Buffer
	began = time.Now()
	initial := count.Load()
	err := backup.CreateStream(context.Background(), f.s, "synthetic-operational-backup-passphrase", &encrypted, backup.DefaultLimits())
	exportTime := time.Since(began)
	during := count.Load() - initial
	cancel()
	trafficErr := <-trafficDone
	joined = true
	if err != nil || trafficErr != nil || during < 1 {
		t.Fatalf("backup/live traffic overlap failed: export=%v payload=%v exchanges=%d", err, trafficErr, during)
	}
	began = time.Now()
	preview, err := backup.PreviewStream(context.Background(), bytes.NewReader(encrypted.Bytes()), "synthetic-operational-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer preview.Close()
	target := filepath.Join(t.TempDir(), "fresh.db")
	key := bytes.Repeat([]byte{82}, 32)
	if err = preview.Restore(context.Background(), target, key); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var desired controlprotocol.Desired
	if err = restored.Get("agent-desired", d.InstanceID, &desired); err != nil || desired.Identity() != d.Identity() {
		t.Fatal("fresh restore lost exact desired identity", err)
	}
	restoreTime := time.Since(began)
	if err = roundTrip(); err != nil {
		t.Fatal("backup/restore disturbed live original flow", err)
	}
	observation, err := supervisor.Observe(context.Background(), root)
	if err != nil || observation.Identity != d.Identity() {
		t.Fatal("backup changed native identity", err)
	}
	// Exact payload attribution at the native public snapshot seam (no protocol headers).
	expected := uint64(2 * (len("before-renewal") + len("after-original-instance-lease") + int(count.Load()+2)*len("operational-backup-payload")))
	snapshot, err := agent.ReadManagedSnapshot(context.Background(), root)
	if err != nil || snapshot.ActiveFlows != 1 || len(snapshot.Counters) != 1 || snapshot.Counters[0].CumulativeBytes != expected {
		t.Fatalf("operational exact native payload mismatch: expected=%d snapshot=%+v err=%v", expected, snapshot, err)
	}
	settlementStarted := time.Now()
	settlementDeadline := settlementStarted.Add(20 * time.Second)
	for {
		usage, usageErr := f.s.Usage(userID, time.Time{}, time.Time{})
		if usageErr != nil {
			t.Fatal(usageErr)
		}
		if usage.RawBytes == int64(expected) && usage.WeightedBytes == int64(expected) {
			break
		}
		if time.Now().After(settlementDeadline) {
			t.Fatalf("operational CP settlement mismatch expected=%d usage=%+v", expected, usage)
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Logf("operational exact traffic: native and CP raw/weighted=%d bytes; active-flow settlement=%s", expected, time.Since(settlementStarted))
	t.Logf("operational encrypted backup: bytes=%d export=%s payload-exchanges-during=%d fresh-verify-restore-reopen=%s; restored copy not activated", encrypted.Len(), exportTime, during, restoreTime)
	// Bound a genuine CP authority loss by the existing admission lease, not a process kill.
	gate.Store(true)
	lostAt := time.Now()
	conn.SetReadDeadline(lostAt.Add(entrypolicy.MaxLease + 3*time.Second))
	n, readErr := conn.Read(make([]byte, 1))
	if timeout, ok := readErr.(net.Error); n != 0 || readErr == nil || (ok && timeout.Timeout()) {
		t.Fatalf("CP outage left existing payload open beyond admission lease: bytes=%d err=%v", n, readErr)
	}
	expiryTime := time.Since(lostAt)
	observation, err = supervisor.Observe(context.Background(), root)
	if err != nil || observation.Identity != d.Identity() {
		t.Fatal("authority-loss drill only passed because whole native runtime exited", err)
	}
	conn.Close()
	finalDeadline := time.Now().Add(2 * time.Second)
	for gate.blockedFinal.Load() == 0 {
		if time.Now().After(finalDeadline) {
			t.Fatal("did not observe blocked final settlement")
		}
		time.Sleep(5 * time.Millisecond)
	}
	reviews, err := f.s.AdmissionBudgetReviews(d.InstanceID, time.Now())
	if err != nil || len(reviews) != 1 || !reviews[0].Unresolved || reviews[0].Closed || reviews[0].SettledRaw != expected {
		t.Fatalf("lost final was incorrectly refunded or charged: %+v %v", reviews, err)
	}
	// Keep CP transport unavailable so the driver cannot authorize a replacement yet.
	stopStarted := time.Now()
	stopDriver()
	stopped, err := supervisor.Observe(context.Background(), root)
	if err != nil || !stopped.Known || !stopped.Quiescent || stopped.Identity != (controlprotocol.Identity{}) {
		t.Fatal("cannot attest stopped runtime", err, stopped)
	}
	closedEpoch := snapshot.CounterEpoch
	retainedProof, proofErr := operationalRetainedProof(root, d.Scope, closedEpoch)
	if proofErr != nil || retainedProof == nil || len(retainedProof.Final.Counters) != 1 || retainedProof.Final.Counters[0].CumulativeBytes != expected {
		t.Fatal("stopped runtime lacks exact native final measurement", proofErr)
	}
	retainedFinal := retainedProof.Final
	command := store.AdmissionBudgetResolution{LeaseID: reviews[0].LeaseID, ExpectedDigest: reviews[0].Digest, AdmittedBytes: expected, RuntimeStopped: true, Reason: "Synthetic CP outage recovery", Evidence: "Owned runtime stopped; exact native final journal verified"}
	endpoint := f.srv.URL + "/api/agent/instances/" + d.InstanceID + "/admission-budgets/finalize"
	if code, _, raw := req(t, operatorClient(), "POST", endpoint, "", command); code != 200 {
		t.Fatalf("explicit final reconciliation: %d %s", code, raw)
	}
	if code, _, _ := req(t, operatorClient(), "POST", endpoint, "", command); code != 409 {
		t.Fatalf("final reconciliation replay accepted: %d", code)
	}
	usage, err := f.s.Usage(userID, time.Time{}, time.Time{})
	if err != nil || usage.RawBytes != int64(expected) || usage.WeightedBytes != int64(expected) {
		t.Fatal("reconciliation duplicated exact usage", err, usage)
	}
	reconciledTime := time.Since(stopStarted)
	gate.Store(false)
	reconnectedAt := time.Now()
	reconciler = restartDriver()
	reconnectDeadline := reconnectedAt.Add(20 * time.Second)
	var recovered controlprotocol.Desired
	for {
		state := reconciler.State()
		if state.Phase == agent.ObservedConformant && state.Observed != nil && state.Observed.Generation == d.Generation+1 {
			if err = f.s.Get("agent-desired", d.InstanceID, &recovered); err != nil || recovered.Generation != d.Generation+1 {
				t.Fatal("recovery generation mismatch", err)
			}
			break
		}
		if time.Now().After(reconnectDeadline) {
			t.Fatal("fresh-generation runtime recovery did not complete")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Reopened driver must deliver actual terminal custody for the previous epoch.
	custodyCtx, custodyCancel := context.WithDeadline(context.Background(), reconnectDeadline)
	defer custodyCancel()
	for {
		proof, custodyErr := operationalCustody(custodyCtx, f.s, d.Scope, closedEpoch)
		if custodyErr != nil {
			t.Fatal(custodyErr)
		}
		if proof != nil {
			if !reflect.DeepEqual(proof.Final, retainedFinal) || len(proof.Final.Counters) != 1 || proof.Final.Counters[0].CumulativeBytes != expected {
				t.Fatal("CP custody changed exact stopped measurement")
			}
			break
		}
		if time.Now().After(reconnectDeadline) {
			t.Fatal("reopened driver did not transfer terminal evidence custody")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var renewed net.Conn
	for {
		renewed, err = dial()
		if err == nil {
			break
		}
		if time.Now().After(reconnectDeadline) {
			t.Fatal("restored CP authority did not admit fresh payload", err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Logf("operational long CP outage: existing flow restricted=%s (<=%s), native stayed live until driver cancel/drain; stopped-final reconciliation=%s, durable reopen/fresh-generation/readmission=%s", expiryTime, entrypolicy.MaxLease+3*time.Second, reconciledTime, time.Since(reconnectedAt))
	newSnapshot, snapshotErr := agent.ReadManagedSnapshot(context.Background(), root)
	if snapshotErr != nil || newSnapshot.CounterEpoch == closedEpoch || newSnapshot.CounterEpoch == "" {
		t.Fatal("fresh runtime epoch missing after durable reopen", snapshotErr)
	}
	return renewed, recovered, newSnapshot.CounterEpoch

}

// Called only after the owned driver returns. No second stop or global PID scan:
// the existing supervisor must establish absence from its stable ownership record.
func checkOperationalTerminal(t *testing.T, f fleetFixture, supervisor *agent.ProcessSupervisor, spool *agent.MeterSpool, root string, scope controlprotocol.Scope, epoch, user string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	observation, err := supervisor.Observe(ctx, root)
	absent := err == nil && observation.Known && observation.Quiescent && observation.Identity == (controlprotocol.Identity{})
	if !absent {
		t.Errorf("terminal owned absence unknown: %v", err)
	}
	journal, journalErr := agent.ReadManagedJournal(root)
	if journalErr != nil {
		t.Errorf("terminal journal invalid: %v", journalErr)
	}
	finalFiles := 0
	currentFinalFile := false
	entries, readErr := os.ReadDir(agent.ManagedJournalDirectory(root))
	if readErr != nil {
		t.Errorf("terminal journal directory: %v", readErr)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".final.json") {
			finalFiles++
			if entry.Name() == epoch+".final.json" {
				currentFinalFile = true
			}
		}
	}
	_, markerErr := os.Lstat(filepath.Join(agent.ManagedJournalDirectory(root), "running.json"))
	if !os.IsNotExist(markerErr) {
		t.Errorf("terminal native final incomplete: final_files=%d running_marker_error=%v", finalFiles, markerErr)
	}
	pending := len(spool.Pending())
	_, retirementErr := os.Lstat(filepath.Join(root, "meters", "managed-retirement.json"))
	retired := finalFiles == 0 && len(journal) == 0 && journalErr == nil && pending == 0 && os.IsNotExist(markerErr) && os.IsNotExist(retirementErr)
	if finalFiles > 0 {
		if _, proofErr := operationalRetainedProof(root, scope, epoch); proofErr != nil || !currentFinalFile {
			t.Errorf("terminal current-epoch final proof invalid: %v", proofErr)
		}
	}
	// Empty local files alone never prove terminal custody. Match the runtime epoch.
	if finalFiles == 0 {
		proof, custodyErr := operationalCustody(ctx, f.s, scope, epoch)
		if !retired || custodyErr != nil || proof == nil {
			t.Errorf("terminal final lacks exact CP custody: epoch=%s error=%v", epoch, custodyErr)
		}
	}
	if !os.IsNotExist(retirementErr) {
		t.Errorf("terminal retirement incomplete: %v", retirementErr)
	}
	if pending != 0 {
		t.Errorf("terminal CP transport obligations remain: batches=%d", pending)
	}
	reviews, reviewErr := f.s.AdmissionBudgetReviews(scope.InstanceID, time.Now())
	if reviewErr != nil {
		t.Errorf("terminal budget review unavailable: %v", reviewErr)
	}
	open, unresolved := 0, 0
	var retainedRaw, settledRaw uint64
	for _, review := range reviews {
		settledRaw += review.SettledRaw
		if !review.Closed {
			open++
			if review.GrantedRaw > review.SettledRaw {
				retainedRaw += review.GrantedRaw - review.SettledRaw
			}
		}
		if review.Unresolved {
			unresolved++
		}
	}
	// The earlier injected final failure is manually resolved in this drill.
	// At terminal shutdown authority is connected and revocation has completed.
	if open != 0 || unresolved != 0 || retainedRaw != 0 {
		t.Errorf("terminal unresolved admission obligations: open=%d unresolved=%d retained_raw=%d", open, unresolved, retainedRaw)
	}
	usage, usageErr := f.s.Usage(user, time.Time{}, time.Time{})
	if usageErr != nil || usage.RawBytes != int64(settledRaw) || usage.WeightedBytes != int64(settledRaw) {
		t.Errorf("terminal settled budget/CP usage mismatch: settled=%d raw=%d weighted=%d error=%v", settledRaw, usage.RawBytes, usage.WeightedBytes, usageErr)
	}
	t.Logf("operational terminal: owned_absent=%t final_files=%d journal_snapshots=%d running_marker_absent=%t local_retirement_complete=%t pending_batches=%d budget_records=%d open_budgets=%d unresolved_budgets=%d retained_raw=%d settled_raw=%d", absent, finalFiles, len(journal), os.IsNotExist(markerErr), retired, pending, len(reviews), open, unresolved, retainedRaw, settledRaw)
}

// Failure-only private forensic copies, never activated or claimed as an atomic
// backup. Fixture key is synthetic makeServerAt context, not an operator key.
func preserveOperationalFailure(t *testing.T, database, root string) {
	t.Helper()
	dir := filepath.Join(root, "failure-forensics")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Errorf("preserve forensic directory: %v", err)
		return
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		source, err := os.Open(database + suffix)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Errorf("open forensic DB: %v", err)
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(source, (32<<20)+1))
		source.Close()
		if readErr != nil || len(raw) > 32<<20 {
			t.Errorf("forensic DB unavailable or exceeds32MiB: %v", readErr)
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, "db"+suffix), raw, 0600); err != nil {
			t.Errorf("write forensic DB: %v", err)
		}
	}
	stacks := make([]byte, 1<<20)
	n := runtime.Stack(stacks, true)
	for name, data := range map[string][]byte{"goroutines.txt": stacks[:n], "synthetic-fixture-key.hex": []byte(strings.Repeat("0b", 32) + "\n"), "README.txt": []byte("Non-atomic physical diagnostic copies only; no restore/activation proof. Synthetic makeServerAt key. Goroutine capture may be truncated at1MiB.\n")} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Errorf("write private forensic context: %v", err)
		}
	}
	t.Logf("private operational failure evidence retained: %s", root)
}

func operationalExpectedOutage(err error) bool {
	var transport *agent.TransportError
	return errors.As(err, &transport) && transport.Status == http.StatusServiceUnavailable && transport.Code == "request_rejected"
}
func operationalStoppedState(state agent.State) bool {
	return state.Phase == "stopped" && state.Code == "local_session_stopped" && state.Observed == nil && !state.RecoveryRequired
}

// Bounded read-only operator discovery, followed by exact proof revalidation.
func operationalCustody(ctx context.Context, s *store.Store, scope controlprotocol.Scope, epoch string) (*entrypolicy.TerminalEvidence, error) {
	return boundedOperationalCustody(ctx, s, scope, epoch, 16)
}

type operationalCustodyReader interface {
	DiscoverMeterTerminalEvidence(context.Context, string, string, string) (store.TerminalEvidencePage, error)
	MeterTerminalEvidence(string, string, string, uint64) (store.TerminalMeterEvidence, error)
}

func boundedOperationalCustody(ctx context.Context, s operationalCustodyReader, scope controlprotocol.Scope, epoch string, maxPages int) (*entrypolicy.TerminalEvidence, error) {
	if epoch == "" {
		return nil, errors.New("runtime epoch required for custody")
	}
	cursor := ""
	for pageNumber := 0; pageNumber < maxPages; pageNumber++ {
		page, err := s.DiscoverMeterTerminalEvidence(ctx, scope.InstanceID, scope.EnrollmentEpoch, cursor)
		if err != nil {
			return nil, err
		}
		for _, locator := range page.Items {
			if locator.RuntimeEpoch != epoch {
				continue
			}
			stored, err := s.MeterTerminalEvidence(scope.InstanceID, scope.EnrollmentEpoch, locator.StreamEpoch, locator.Sequence)
			if err != nil {
				return nil, err
			}
			proof := stored.TerminalEvidence
			if proof == nil || proof.Validate() != nil || proof.NodeID != scope.NodeID || proof.InstanceID != scope.InstanceID || proof.EnrollmentEpoch != scope.EnrollmentEpoch || proof.RuntimeEpoch != epoch {
				return nil, errors.New("terminal custody scope mismatch")
			}
			return proof, nil
		}
		if !page.HasMore {
			return nil, nil
		}
		cursor = page.NextCursor
	}
	return nil, errors.New("custody discovery exceeded bounded pages")
}

// The filename, baseline and final must all bind the same tracked runtime epoch.
func operationalRetainedProof(root string, scope controlprotocol.Scope, epoch string) (*entrypolicy.TerminalEvidence, error) {
	if epoch == "" || strings.ContainsAny(epoch, "/\\") {
		return nil, errors.New("invalid retained epoch")
	}
	proof := &entrypolicy.TerminalEvidence{Version: entrypolicy.TerminalCustodyVersion, NodeID: scope.NodeID, InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, RuntimeEpoch: epoch}
	for kind, target := range map[string]*entrypolicy.Snapshot{"baseline": &proof.Baseline, "final": &proof.Final} {
		path := filepath.Join(agent.ManagedJournalDirectory(root), epoch+"."+kind+".json")
		info, err := os.Lstat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4<<20 {
			return nil, errors.New("invalid private bounded native journal")
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		raw, readErr := io.ReadAll(io.LimitReader(file, (4<<20)+1))
		closeErr := file.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if len(raw) > 4<<20 {
			return nil, errors.New("native journal exceeds bound")
		}
		if err = json.Unmarshal(raw, target); err != nil {
			return nil, err
		}
	}
	proof.Digest = proof.ComputeDigest()
	if err := proof.Validate(); err != nil {
		return nil, err
	}
	return proof, nil
}
