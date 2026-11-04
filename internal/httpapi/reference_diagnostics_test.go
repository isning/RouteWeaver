package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func referenceDiagnosticsEnabled(seconds int, operational, provider bool) bool {
	return seconds == 1800 && !operational && !provider
}

func TestReferenceDiagnosticsExactOptIn(t *testing.T) {
	for _, seconds := range []int{0, 30, 120, 1799, 1800} {
		for _, operational := range []bool{false, true} {
			for _, provider := range []bool{false, true} {
				if got, want := referenceDiagnosticsEnabled(seconds, operational, provider), seconds == 1800 && !operational && !provider; got != want {
					t.Fatalf("opt-in seconds=%d operational=%t provider=%t got=%t", seconds, operational, provider, got)
				}
			}
		}
	}
}

// This is a bounded, opt-in fixture recorder, not production request logging.
type referenceDiagnostics struct {
	URL          string
	t            *testing.T
	enabled      bool
	recording    bool // Redacted timeline only; never authorizes private evidence.
	databasePath string
	mu           sync.Mutex
	phase        string
	events       []map[string]any
	admissions   []map[string]any
}

func newReferenceDiagnostics(t *testing.T, f fleetFixture, enabled bool, recordOnly ...bool) *referenceDiagnostics {
	t.Helper()
	d := &referenceDiagnostics{URL: f.srv.URL, t: t, enabled: enabled, databasePath: f.databasePath, phase: "warmup"}
	d.recording = enabled || (len(recordOnly) > 0 && recordOnly[0])
	if d.recording {
		server := httptest.NewServer(d.wrap(f.srv.Config.Handler))
		d.URL = server.URL
		t.Cleanup(server.Close)
	}
	return d
}

func (d *referenceDiagnostics) SetPhase(phase string) {
	switch phase {
	case "warmup", "observation", "revoke", "cleanup":
	default:
		phase = "other"
	}
	d.mu.Lock()
	d.phase = phase
	d.mu.Unlock()
	d.add(map[string]any{"kind": "phase"})
}

func (d *referenceDiagnostics) add(event map[string]any) {
	if !d.enabled && !d.recording {
		return
	}
	event["at"] = time.Now().UTC()
	d.mu.Lock()
	defer d.mu.Unlock()
	event["lifecycle_phase"] = d.phase
	if len(d.events) == 1024 {
		copy(d.events, d.events[1:])
		d.events = d.events[:1023]
	}
	d.events = append(d.events, event)
	if event["route"] == "admission-leases" || event["route"] == "admission-release" {
		if len(d.admissions) == 64 {
			copy(d.admissions, d.admissions[1:])
			d.admissions = d.admissions[:63]
		}
		d.admissions = append(d.admissions, event)
	}
}

func referenceErrorType(err error) string {
	if err == nil {
		return ""
	}
	// Error text can include URLs, credentials or bodies. Record only its Go type.
	return fmt.Sprintf("%T", err)
}
func referenceErrorClass(err error) map[string]any {
	var network net.Error
	return map[string]any{"deadline": errors.Is(err, context.DeadlineExceeded), "canceled": errors.Is(err, context.Canceled), "timeout": errors.As(err, &network) && network.Timeout(), "eof": errors.Is(err, io.EOF), "unexpected_eof": errors.Is(err, io.ErrUnexpectedEOF)}
}
func (d *referenceDiagnostics) Record(kind string, err error) {
	switch kind {
	case "driver_transport", "driver_exit":
	default:
		kind = "other"
	}
	d.add(map[string]any{"kind": kind, "error_type": referenceErrorType(err), "error_class": referenceErrorClass(err)})
}
func (d *referenceDiagnostics) Payload(sample, n int, phase string, lag time.Duration, err error) {
	switch phase {
	case "write", "read", "schedule":
	default:
		phase = "other"
	}
	d.add(map[string]any{"kind": "payload", "sample": sample, "bytes": n, "phase": phase, "lag_ns": int64(lag), "error_type": referenceErrorType(err), "error_class": referenceErrorClass(err)})
}

func referenceRoute(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 6 && parts[0] == "api" && parts[1] == "agent" && parts[2] == "instances" && parts[4] == "admission-leases" {
		return "admission-release"
	}
	if len(parts) != 5 || parts[0] != "api" || parts[1] != "agent" || parts[2] != "instances" {
		return "other"
	}
	switch parts[4] {
	case "admission-leases", "desired", "observations", "meter-batches", "accounting-pending", "meter-baseline", "meter-bindings", "service-heartbeat", "node-observations", "entry-bindings":
		return parts[4]
	}
	return "other"
}

// Keep a prefix without changing the bytes or errors delivered to the handler.
type referenceCapture struct {
	bytes.Buffer
	overflow bool
}

func (b *referenceCapture) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 8192 - b.Len()
	if n > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

type referenceBody struct {
	io.Reader
	io.Closer
}
type referenceResponse struct {
	http.ResponseWriter
	status  int
	capture referenceCapture
}

func (w *referenceResponse) WriteHeader(status int) {
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *referenceResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	_, _ = w.capture.Write(p[:n])
	return n, err
}
func (w *referenceResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func referenceScalars(b *referenceCapture, request bool) map[string]any {
	out := map[string]any{}
	if b.overflow {
		return out
	}
	if request {
		var v struct {
			AdmittedBytes *uint64 `json:"admittedBytes,string"`
			Final         *bool   `json:"final"`
		}
		if json.Unmarshal(b.Bytes(), &v) != nil {
			return out
		}
		if v.AdmittedBytes != nil {
			out["admittedBytes"] = *v.AdmittedBytes
		}
		if v.Final != nil {
			out["final"] = *v.Final
		}
	} else {
		var v struct {
			Allowed    *bool      `json:"allowed"`
			Reason     string     `json:"reason"`
			ExpiresAt  *time.Time `json:"expiresAt"`
			ByteBudget *uint64    `json:"byteBudget,string"`
		}
		if json.Unmarshal(b.Bytes(), &v) != nil {
			return out
		}
		if v.Allowed != nil {
			out["allowed"] = *v.Allowed
		}
		// Reasons are protocol enums, never arbitrary handler error strings.
		switch v.Reason {
		case "", "ok", "enrollment-revoked", "entry-not-bound", "presence-closed", "ip-limit", "connection-limit", "presence-capacity", "disabled", "credential-revoked", "deployment-unverified", "route-not-entitled", "quota-budget-pending", "policy-boundary-reconnect", "quota-reserved":
			out["reason"] = v.Reason
		}
		if v.ExpiresAt != nil {
			out["expiresAt"] = v.ExpiresAt
		}
		if v.ByteBudget != nil {
			out["byteBudget"] = *v.ByteBudget
		}
	}
	return out
}
func (d *referenceDiagnostics) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		route := referenceRoute(r.URL.Path)
		request := &referenceCapture{}
		if (route == "admission-leases" || route == "service-heartbeat") && r.Body != nil {
			r.Body = &referenceBody{Reader: io.TeeReader(r.Body, request), Closer: r.Body}
		}
		response := &referenceResponse{ResponseWriter: w}
		next.ServeHTTP(response, r)
		status := response.status
		if status == 0 {
			status = 200
		}
		event := map[string]any{"kind": "rpc", "route": route, "status": status, "duration_ns": int64(time.Since(start)), "started_at": start.UTC()}
		if route == "admission-leases" {
			event["request"] = referenceScalars(request, true)
			event["response"] = referenceScalars(&response.capture, false)
		}
		if route == "service-heartbeat" {
			event["request"] = referenceHeartbeatScalars(request, true)
			event["response"] = referenceHeartbeatScalars(&response.capture, false)
		}
		d.add(event)
	})
}

// Only typed lease timestamps are admissible. Never serialize protocol identities,
// credentials, arbitrary error text, database contents or process output to CI.
func referenceHeartbeatScalars(b *referenceCapture, request bool) map[string]any {
	out := map[string]any{}
	if b.overflow {
		return out
	}
	var v struct {
		PolicyIssuedAt *time.Time `json:"policyIssuedAt"`
		PolicyRefresh  *struct {
			Lease struct {
				IssuedAt  *time.Time `json:"issuedAt"`
				ExpiresAt *time.Time `json:"expiresAt"`
			} `json:"policyLease"`
		} `json:"policyRefresh"`
	}
	if json.Unmarshal(b.Bytes(), &v) != nil {
		return out
	}
	if request && v.PolicyIssuedAt != nil {
		out["policyIssuedAt"] = v.PolicyIssuedAt
	}
	if !request && v.PolicyRefresh != nil {
		if v.PolicyRefresh.Lease.IssuedAt != nil {
			out["issuedAt"] = v.PolicyRefresh.Lease.IssuedAt
		}
		if v.PolicyRefresh.Lease.ExpiresAt != nil {
			out["expiresAt"] = v.PolicyRefresh.Lease.ExpiresAt
		}
	}
	return out
}

// The existing rings bound CI output. Private evidence remains separately gated.
func (d *referenceDiagnostics) failureTimeline(failed bool) []byte {
	if !failed || (!d.enabled && !d.recording) {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	data, _ := json.Marshal(map[string]any{"events": d.events, "admissions": d.admissions})
	return data
}

// Preserve only after failed tests, into a private retained fixture root. Copies
// are diagnostic physical images, NOT an atomic SQLite backup or restore proof.
func (d *referenceDiagnostics) Preserve(root string) error {
	if !d.enabled || !d.t.Failed() {
		return nil
	}
	destination := filepath.Join(root, "reference-diagnostics")
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	d.mu.Lock()
	data, err := json.MarshalIndent(map[string]any{"events": d.events, "admissions": d.admissions}, "", "  ")
	d.mu.Unlock()
	if err != nil {
		return err
	}
	write := func(name string, data []byte) error {
		return os.WriteFile(filepath.Join(destination, name), data, 0600)
	}
	if err = write("events.json", data); err != nil {
		return err
	}
	stacks := make([]byte, 2<<20)
	n := runtime.Stack(stacks, true)
	if err = write("goroutines.txt", stacks[:n]); err != nil {
		return err
	}
	if err = write("synthetic-fixture-key.hex", []byte(strings.Repeat("0b", 32)+"\n")); err != nil {
		return err
	}
	manifest := map[string]any{"warning": "Non-atomic diagnostic copies, not a restorable backup; key is synthetic fixture only", "stacks_may_be_truncated": n == len(stacks)}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		name := "db" + suffix
		file, e := os.Open(d.databasePath + suffix)
		if e != nil {
			manifest[name] = map[string]any{"available": false, "error_type": referenceErrorType(e)}
			continue
		}
		// Bound both allocation and copied output, even if a file grows while reading.
		content, e := io.ReadAll(io.LimitReader(file, (32<<20)+1))
		file.Close()
		if e != nil {
			manifest[name] = map[string]any{"available": false, "error_type": referenceErrorType(e)}
			continue
		}
		truncated := len(content) > 32<<20
		if truncated {
			content = content[:32<<20]
		}
		if err = write(name, content); err != nil {
			return err
		}
		manifest[name] = map[string]any{"available": true, "copied_bytes": len(content), "truncated": truncated}
	}
	data, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return write("manifest.json", data)
}

func TestReferenceDiagnosticsRingAndRedaction(t *testing.T) {
	d := &referenceDiagnostics{enabled: true}
	handler := d.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Write([]byte(`{"allowed":true,"reason":"ok","byteBudget":"45","leaseId":"secret-response"}`))
	}))
	req := httptest.NewRequest("POST", "/api/agent/instances/secret-id/admission-leases", strings.NewReader(`{"admittedBytes":"12","final":false,"subjectId":"secret-request"}`))
	req.Header.Set("Authorization", "secret-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	data, _ := json.Marshal(d.events)
	if strings.Contains(string(data), "secret") || !strings.Contains(string(data), `"byteBudget":45`) || !strings.Contains(string(data), `"admittedBytes":12`) {
		t.Fatal("allowlisted fields/redaction failed", string(data))
	}
	if !strings.Contains(response.Body.String(), "secret-response") {
		t.Fatal("wrapper changed response")
	}
	for i := 0; i < 1036; i++ {
		d.Payload(i, 1, "read", 0, nil)
	}
	if len(d.events) != 1024 || d.events[0]["sample"] != 12 {
		t.Fatal("ring is not bounded/ordered")
	}
}
func TestReferenceDiagnosticsCaptureBound(t *testing.T) {
	var capture referenceCapture
	input := bytes.Repeat([]byte("x"), 10000)
	n, err := capture.Write(input)
	if n != len(input) || err != nil || capture.Len() != 8192 || !capture.overflow {
		t.Fatal("capture not bounded")
	}
	if len(referenceScalars(&capture, true)) != 0 {
		t.Fatal("truncated body parsed")
	}
}

// Capture at the observed failure, before driver cancellation can erase blocked
// goroutines. Caller invokes only on a payload failure (before t.Fatal).
func (d *referenceDiagnostics) CaptureStacks(root string) error {
	if !d.enabled {
		return nil
	}
	destination := filepath.Join(root, "reference-diagnostics")
	if err := os.MkdirAll(destination, 0700); err != nil {
		return err
	}
	stacks := make([]byte, 1<<20)
	n := runtime.Stack(stacks, true)
	return os.WriteFile(filepath.Join(destination, "goroutines-at-failure.txt"), stacks[:n], 0600)
}

func TestReferenceDiagnosticsAdmissionHistorySurvivesPollChurn(t *testing.T) {
	d := &referenceDiagnostics{enabled: true}
	for i := 0; i < 80; i++ {
		d.add(map[string]any{"route": "admission-leases", "sequence": i})
	}
	for i := 0; i < 1500; i++ {
		d.add(map[string]any{"route": "desired"})
	}
	if len(d.events) != 1024 || len(d.admissions) != 64 || d.admissions[0]["sequence"] != 16 {
		t.Fatal("admission ring lost history under polling")
	}
}

func TestReferenceDiagnosticsSuccessDoesNotPreserve(t *testing.T) {
	root := t.TempDir()
	d := &referenceDiagnostics{enabled: true, t: t}
	if err := d.Preserve(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "reference-diagnostics")); !os.IsNotExist(err) {
		t.Fatal("successful test retained private diagnostics")
	}
}

// A normal reference has no manual budget-resolution step. Observe obligations,
// never infer their settlement from process absence or an empty native journal.
func checkReferenceTerminal(t *testing.T, f fleetFixture, supervisor *agent.ProcessSupervisor, reconciler *agent.Reconciler, spool *agent.MeterSpool, root string, scope controlprotocol.Scope, epoch string) {
	t.Helper()
	if !operationalStoppedState(reconciler.State()) {
		t.Error("reference driver did not reach conclusive stopped state")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	observation, observeErr := supervisor.Observe(ctx, root)
	absent := observeErr == nil && observation.Known && observation.Quiescent && observation.Identity == (controlprotocol.Identity{})
	if !absent {
		t.Error("reference terminal owned absence unknown")
	}
	retained, retainedErr := operationalRetainedProof(root, scope, epoch)
	var custody *entrypolicy.TerminalEvidence
	var custodyErr error
	// At most256pages/4096metadata rows: fixed before the reference, still
	// bounded by the original1s observer context. Do not scan if local proof exists.
	if retainedErr != nil || retained == nil {
		custody, custodyErr = boundedOperationalCustody(ctx, f.s, scope, epoch, 256)
	}
	if (retainedErr != nil || retained == nil) && (custodyErr != nil || custody == nil) {
		t.Errorf("reference terminal lacks validated exact-epoch evidence: retained_error_type=%s custody_error_type=%s", referenceErrorType(retainedErr), referenceErrorType(custodyErr))
	}
	_, markerErr := os.Lstat(filepath.Join(agent.ManagedJournalDirectory(root), "running.json"))
	if !os.IsNotExist(markerErr) {
		t.Error("reference terminal running marker is not absent")
	}
	reviews, reviewErr := f.s.AdmissionBudgetReviews(scope.InstanceID, time.Now())
	if reviewErr != nil {
		t.Error("reference terminal budget observation unavailable")
	}
	open, unresolved := 0, 0
	var held uint64
	for _, review := range reviews {
		if !review.Closed {
			open++
			if review.GrantedRaw > review.SettledRaw {
				held += review.GrantedRaw - review.SettledRaw
			}
		}
		if review.Unresolved {
			unresolved++
		}
	}
	t.Logf("reference terminal: owned_absent=%t retained_exact_proof=%t cp_custody_checked=%t cp_exact_custody=%t pending_batches=%d open_budgets=%d unresolved_budgets=%d held_raw=%d; observations do not imply settlement", absent, retainedErr == nil && retained != nil, retainedErr != nil || retained == nil, custodyErr == nil && custody != nil, len(spool.Pending()), open, unresolved, held)
}

func TestReferenceDiagnosticsUntrustedScalarsAndErrors(t *testing.T) {
	for _, raw := range []string{
		`{"reason":"secret_lowercase_credential","allowed":true,"byteBudget":"7"}`,
		`{"reason":"https://secret.example","allowed":true,"byteBudget":"7"}`,
	} {
		var capture referenceCapture
		capture.Write([]byte(raw))
		value := referenceScalars(&capture, false)
		if _, exists := value["reason"]; exists {
			t.Fatal("unallowlisted reason retained")
		}
		if value["byteBudget"] != uint64(7) {
			t.Fatal("numeric scalar lost")
		}
	}
	for _, raw := range []string{`{"admittedBytes":7}`, `{"admittedBytes":"-1"}`, `{"admittedBytes":"18446744073709551616"}`, `{"admittedBytes":"7"} trailing`} {
		var capture referenceCapture
		capture.Write([]byte(raw))
		if len(referenceScalars(&capture, true)) != 0 {
			t.Fatal("invalid scalar parsed")
		}
	}
	d := &referenceDiagnostics{enabled: true}
	d.SetPhase("secret-phase")
	d.Record("secret-kind", fmt.Errorf("secret-body: %w", context.DeadlineExceeded))
	d.Payload(410, 0, "secret-phase", time.Second, io.ErrUnexpectedEOF)
	raw, err := json.Marshal(d.events)
	if err != nil || strings.Contains(string(raw), "secret") {
		t.Fatal("untrusted error/phase leaked")
	}
	if !strings.Contains(string(raw), `"deadline":true`) || !strings.Contains(string(raw), `"unexpected_eof":true`) {
		t.Fatal("error classes lost")
	}
	for _, path := range []string{"/secret", "/api/agent/instances/secret/unknown", "/api/agent/instances/secret/admission-leases/secret"} {
		if strings.Contains(referenceRoute(path), "secret") {
			t.Fatal("path identity leaked")
		}
	}
}

type referenceCustodyPages struct {
	pages      int
	target     int
	exactReads int
	exactError error
	proof      *entrypolicy.TerminalEvidence
}

func (f *referenceCustodyPages) DiscoverMeterTerminalEvidence(ctx context.Context, _, _, cursor string) (store.TerminalEvidencePage, error) {
	if err := ctx.Err(); err != nil {
		return store.TerminalEvidencePage{}, err
	}
	if cursor != fmt.Sprint(f.pages) && !(f.pages == 0 && cursor == "") {
		return store.TerminalEvidencePage{}, errors.New("cursor not continued")
	}
	f.pages++
	page := store.TerminalEvidencePage{HasMore: true, NextCursor: fmt.Sprint(f.pages), Examined: 16}
	if f.pages == f.target {
		page.Items = []store.TerminalEvidenceLocator{{RuntimeEpoch: "tracked", StreamEpoch: "stream", Sequence: 2000}}
	}
	return page, nil
}
func (f *referenceCustodyPages) MeterTerminalEvidence(_, _, _ string, _ uint64) (store.TerminalMeterEvidence, error) {
	f.exactReads++
	return store.TerminalMeterEvidence{TerminalEvidence: f.proof}, f.exactError
}
func TestReferenceDiagnosticsCustodyPaginationRemainsBounded(t *testing.T) {
	sentinel := errors.New("exact proof unavailable")
	scope := controlprotocol.Scope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment"}
	counter := entrypolicy.Counter{CounterEpoch: "tracked-source", Binding: entrypolicy.Binding{SubjectID: "subject", AccountID: "account", RouteID: "route", EntryID: "entry", InboundTag: "public", CredentialVersion: "v1", PolicyRevision: "policy", CycleID: "cycle"}, MeasurementLayer: entrypolicy.MeasurementLayer}
	baseline := entrypolicy.Snapshot{LedgerMode: "admission-budget", ObservedAt: time.Now().UTC(), AdapterID: agent.ManagedXrayID, RuntimeVersion: agent.ManagedXrayVersion, CounterEpoch: "tracked", Counters: []entrypolicy.Counter{counter}}
	valid := &entrypolicy.TerminalEvidence{Version: 1, NodeID: scope.NodeID, InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, RuntimeEpoch: "tracked", Baseline: baseline, Final: baseline}
	valid.Digest = valid.ComputeDigest()
	successful := &referenceCustodyPages{target: 20, proof: valid}
	if proof, err := boundedOperationalCustody(context.Background(), successful, scope, "tracked", 256); err != nil || proof == nil || successful.pages != 20 {
		t.Fatal("valid late-page proof not found")
	}
	// Twenty pages contain up to320metadata rows: past the operational256row bound.
	reader := &referenceCustodyPages{target: 20, exactError: sentinel}
	if proof, err := boundedOperationalCustody(context.Background(), reader, scope, "tracked", 256); proof != nil || !errors.Is(err, sentinel) || reader.pages != 20 || reader.exactReads != 1 {
		t.Fatal("long history did not reach exact proof read safely")
	}
	reader = &referenceCustodyPages{target: 257}
	if proof, err := boundedOperationalCustody(context.Background(), reader, scope, "tracked", 256); proof != nil || err == nil || reader.pages != 256 || reader.exactReads != 0 {
		t.Fatal("reference discovery exceeded fixed bound")
	}
	reader = &referenceCustodyPages{target: 20}
	if _, err := boundedOperationalCustody(context.Background(), reader, scope, "tracked", 16); err == nil || reader.pages != 16 {
		t.Fatal("original operational bound changed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reader = &referenceCustodyPages{target: 20}
	if _, err := boundedOperationalCustody(ctx, reader, scope, "tracked", 256); !errors.Is(err, context.Canceled) || reader.pages != 0 {
		t.Fatal("discovery ignored caller deadline")
	}
}

func TestNativeFailureTimelineRedactsHeartbeatAndPreservesHTTP(t *testing.T) {
	d := &referenceDiagnostics{recording: true, phase: "warmup"}
	request := `{"policyIssuedAt":"2026-11-03T14:39:03Z","desired":{"instanceId":"secret-instance"},"token":"secret-token"}`
	response := `{"policyRefresh":{"intentId":"secret-intent","policyLease":{"issuedAt":"2026-11-03T14:39:10Z","expiresAt":"2026-11-03T14:39:25Z"}},"error":"secret-error"}`
	handler := d.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != request {
			t.Fatalf("request changed: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, response)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/agent/instances/secret-instance/service-heartbeat", strings.NewReader(request)))
	if recorder.Code != http.StatusOK || recorder.Body.String() != response {
		t.Fatal("response changed")
	}
	if d.failureTimeline(false) != nil {
		t.Fatal("successful tests must not emit timeline")
	}
	timeline := string(d.failureTimeline(true))
	for _, required := range []string{"policyIssuedAt", "issuedAt", "expiresAt", "2026-11-03T14:39:25Z"} {
		if !strings.Contains(timeline, required) {
			t.Fatalf("missing %s: %s", required, timeline)
		}
	}
	if strings.Contains(timeline, "secret") {
		t.Fatalf("secret leaked: %s", timeline)
	}
	if d.enabled {
		t.Fatal("recording must not enable private evidence")
	}
	root := t.TempDir()
	d.t = t
	if err := d.Preserve(root); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("record-only mode preserved files: %v", err)
	}
}

func TestNativeFailureTimelineHeartbeatRejectsMalformedAndOversized(t *testing.T) {
	for _, body := range []string{`{"policyIssuedAt":"secret"}`, `{"policyRefresh":{"policyLease":{"expiresAt":"secret"}}}`, `{`, strings.Repeat("x", 8193)} {
		var captured referenceCapture
		_, _ = captured.Write([]byte(body))
		for _, request := range []bool{false, true} {
			if got := referenceHeartbeatScalars(&captured, request); len(got) != 0 {
				t.Fatalf("untrusted fields recorded: %v", got)
			}
		}
	}
	d := &referenceDiagnostics{recording: true}
	for i := 0; i < 1200; i++ {
		d.Record("driver_transport", io.EOF)
	}
	if len(d.events) != 1024 {
		t.Fatalf("unbounded timeline: %d", len(d.events))
	}
}
