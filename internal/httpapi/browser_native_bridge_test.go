//go:build browser_native_acceptance

package httpapi_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/render"
)

// This opt-in test binary is a stdin/stdout bridge, never a production endpoint.
// Positive observations come only from the owned native supervisor. No store
// mutation or synthetic conformant state is available to the browser.
func TestBrowserNativeBridge(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_BROWSER_NATIVE_BRIDGE") != "1" {
		t.Fatal("explicit browser-native bridge opt-in required")
	}
	type command struct {
		Action string      `json:"action"`
		URL    string      `json:"url"`
		Token  string      `json:"token"`
		Scope  agent.Scope `json:"scope"`
	}
	emit := func(v any) {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		fmt.Printf("RW_BRIDGE %s\n", b)
	}
	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithTimeout(signalContext, 120*time.Second)
	defer cancel()
	input := make(chan command)
	readErr := make(chan error, 1)
	go func() {
		s := bufio.NewScanner(os.Stdin)
		s.Buffer(make([]byte, 4096), 1<<20)
		for s.Scan() {
			var c command
			if e := json.Unmarshal(s.Bytes(), &c); e != nil {
				readErr <- e
				return
			}
			select {
			case input <- c:
			case <-ctx.Done():
				return
			}
		}
		readErr <- s.Err()
	}()
	var init command
	select {
	case init = <-input:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	case e := <-readErr:
		t.Fatal("initialization absent", e)
	}
	if init.Action != "init" {
		t.Fatal("initialization required")
	}
	binary := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	content, e := os.ReadFile(binary)
	if e != nil {
		t.Fatal(e)
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	if digest != os.Getenv("ROUTEWEAVER_MANAGED_XRAY_SHA256") || len(digest) != 64 {
		t.Fatal("exact built executable digest required")
	}
	root, e := os.MkdirTemp("", "rw-browser-native-")
	if e != nil {
		t.Fatal(e)
	}
	fmt.Fprintln(os.Stderr, "native bridge private evidence root", root)
	clean := false
	defer func() {
		if clean {
			os.RemoveAll(root)
		} else {
			t.Log("retained native evidence", root)
		}
	}()
	binary = filepath.Join(root, "managed-core")
	if e = os.WriteFile(binary, content, 0700); e != nil {
		t.Fatal(e)
	}
	tr, e := agent.NewHTTPTransport(bridgeTransportOptions(init.URL, init.Token, init.Scope))
	if e != nil {
		t.Fatal(e)
	}
	defer tr.Close()
	checker, e := agent.NewNativeChecker(render.ServerAdapterManagedXray, render.ManagedXrayVersion, binary, 5*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	supervisor, e := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if e != nil {
		t.Fatal(e)
	}
	r, e := agent.Open(root, init.Scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: 10 * time.Minute})
	if e != nil {
		t.Fatal(e)
	}
	broker, e := agent.StartAdmissionBroker(root, tr)
	if e != nil {
		r.Close()
		t.Fatal(e)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		_, stopErr := r.StopOwned(stopCtx)
		broker.Close()
		closeErr := r.Close()
		if stopErr != nil || closeErr != nil {
			t.Errorf("owned cleanup failed: stop=%v close=%v", stopErr, closeErr)
			return
		}
		clean = true
	}()
	var state, first agent.State
	emit(map[string]any{"ready": true, "binarySHA256": digest, "adapter": render.ServerAdapterManagedXray, "version": render.ManagedXrayVersion})
	for {
		var c command
		select {
		case c = <-input:
		case <-ctx.Done():
			t.Error("bridge lifecycle ended before explicit close", ctx.Err())
			return
		case e := <-readErr:
			if e != nil {
				t.Error(e)
			}
			return
		}
		opCtx, opCancel := context.WithTimeout(ctx, 10*time.Second)
		var err error
		var startupFailure *agent.State
		var journal *bridgeJournalEvidence
		switch c.Action {
		case "apply":
			d, receiveErr := tr.ReceiveDesired(opCtx, init.Scope, r.State().HighestAccepted)
			err = receiveErr
			if err == nil && d == nil {
				err = fmt.Errorf("no fresh desired")
			}
			if err == nil {
				state, err = r.Submit(opCtx, *d)
				if d.Action == "stop" && bridgeConfirmedRestriction(state, err) {
					err = nil
				}
				if err == nil && d.Action != "stop" && (state.Phase != agent.ObservedConformant || state.Observed == nil || state.Observed.Identity != d.Identity()) {
					err = fmt.Errorf("native observation does not match desired")
				}
				if first.Observed == nil && state.Observed != nil {
					first = state
				}
			}
		case "apply-port-conflict":
			// This command verifies one expected failure, never accepts arbitrary
			// errors, and never reports a guessed outcome to the control plane.
			d, receiveErr := tr.ReceiveDesired(opCtx, init.Scope, r.State().HighestAccepted)
			err = receiveErr
			if err == nil && (d == nil || d.Action != "") {
				err = fmt.Errorf("fresh publication desired required for port conflict")
			}
			if err == nil {
				state, err = r.Submit(opCtx, *d)
				if state.Desired == nil || *state.Desired != d.Identity() || !bridgeStartupUnknown(state, err) {
					err = fmt.Errorf("unexpected startup failure: phase=%s code=%s error=%v", state.Phase, state.Code, err)
				} else {
					initial := state
					startupFailure = &initial
					state, err = r.Recover(opCtx)
					if err == nil && (state.Desired == nil || *state.Desired != d.Identity() || !bridgeRecoveredAbsence(state)) {
						err = fmt.Errorf("startup absence unconfirmed: phase=%s code=%s", state.Phase, state.Code)
					}
				}
			}
		case "report":
			state, err = r.Recover(opCtx)
			if bridgeConfirmedRestriction(state, err) {
				err = nil
			}
			if err == nil {
				err = tr.ReportObservation(opCtx, init.Scope, state)
			}
		case "mismatch":
			b, _ := json.Marshal(state)
			var bad agent.State
			json.Unmarshal(b, &bad)
			if bad.Observed == nil || bad.Desired == nil {
				err = fmt.Errorf("actual observation required")
			} else {
				bad.Observed.OperationID = "wrong-browser-operation"
				bad.Desired.OperationID = "wrong-browser-operation"
				if !bridgeIdentityRejected(tr.ReportObservation(opCtx, init.Scope, bad)) {
					err = fmt.Errorf("mismatched observation accepted")
				}
			}
		case "stale":
			if first.Observed == nil {
				err = fmt.Errorf("first native observation absent")
			} else if !bridgeIdentityRejected(tr.ReportObservation(opCtx, init.Scope, first)) {
				err = fmt.Errorf("old native observation accepted")
			}
		case "journal":
			journal, err = bridgeReadJournal(root)
		case "close":
			opCancel()
			emit(map[string]any{"closing": true})
			return
		default:
			err = fmt.Errorf("unknown bridge action")
		}
		opCancel()
		if err != nil {
			// Read-only, bounded fixture diagnostics. State contains identities,
			// never artifacts, enrollment tokens, or counter/credential contents.
			// A retained meter marker is not cleared merely because a process
			// exited: native absence and accounting reconciliation are distinct.
			marker := "unreadable"
			if info, statErr := os.Lstat(filepath.Join(agent.ManagedJournalDirectory(root), "running.json")); errors.Is(statErr, os.ErrNotExist) {
				marker = "absent"
			} else if statErr == nil && info.Mode().IsRegular() {
				marker = "present"
			}
			emit(map[string]any{"error": err.Error(), "action": c.Action, "state": r.State(), "managedEpochMarker": marker})
			continue
		}
		emit(map[string]any{"action": c.Action, "state": state, "startupFailure": startupFailure, "journal": journal})
	}
}

func bridgeTransportOptions(origin, token string, scope agent.Scope) agent.HTTPTransportOptions {
	return agent.HTTPTransportOptions{BaseURL: origin, Scope: scope, Token: token, RequestTimeout: 2 * time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true}
}

func bridgeConfirmedRestriction(state agent.State, err error) bool {
	return errors.Is(err, agent.ErrLeaseBlocked) && state.Phase == agent.Blocked && state.Code == "policy_restricted" && state.Observed == nil && !state.RecoveryRequired
}
func bridgeIdentityRejected(err error) bool {
	var response *agent.TransportError
	return errors.As(err, &response) && response.Status == 409 && response.Code == "request_rejected"
}
func TestBrowserNativeBridgeClassifiesOnlyExactOutcomes(t *testing.T) {
	t.Run("startup-failure-requires-confirmed-absence", func(t *testing.T) {
		unknown := agent.State{Phase: agent.Unknown, Code: "activation_outcome_unknown", NativeChecked: true, RecoveryRequired: true}
		absent := agent.State{Phase: agent.ApplyFailed, Code: "recovered_not_applied", NativeChecked: true}
		if !bridgeStartupUnknown(unknown, agent.ErrUnknownRuntime) || !bridgeRecoveredAbsence(absent) {
			t.Fatal("exact startup classifications rejected")
		}
		for _, err := range []error{nil, context.DeadlineExceeded, agent.ErrLeaseBlocked, errors.New("startup failed")} {
			if bridgeStartupUnknown(unknown, err) {
				t.Fatal("unrelated failure accepted", err)
			}
		}
		for _, change := range []func(*agent.State){
			func(s *agent.State) { s.Phase = agent.ObservedConformant },
			func(s *agent.State) { s.Code = "runtime_observation_unknown" },
			func(s *agent.State) { s.NativeChecked = false },
			func(s *agent.State) { s.Observed = &agent.Observation{} },
			func(s *agent.State) { s.RecoveryRequired = !s.RecoveryRequired },
		} {
			u, a := unknown, absent
			change(&u)
			change(&a)
			if bridgeStartupUnknown(u, agent.ErrUnknownRuntime) || bridgeRecoveredAbsence(a) {
				t.Fatal("inexact startup classification accepted")
			}
		}
	})
	t.Run("exact-transport-constructor", func(t *testing.T) {
		options := bridgeTransportOptions("http://127.0.0.1:1", "synthetic-private-fixture", agent.Scope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment"})
		transport, err := agent.NewHTTPTransport(options)
		if err != nil {
			t.Fatal("browser bridge transport options rejected before initialization", err)
		}
		transport.Close() // Constructor/close only: no HTTP request or native activation.
		options.Backoff = 0
		if rejected, err := agent.NewHTTPTransport(options); err == nil {
			rejected.Close()
			t.Fatal("missing explicit backoff accepted")
		}
	})
	for _, err := range []error{nil, context.DeadlineExceeded, fmt.Errorf("network disconnected"), &agent.TransportError{Status: 500, Code: "request_rejected"}, &agent.TransportError{Status: 409, Code: "other"}} {
		if bridgeIdentityRejected(err) {
			t.Fatal("non-identity error accepted as rejection", err)
		}
	}
	if !bridgeIdentityRejected(&agent.TransportError{Status: 409, Code: "request_rejected"}) {
		t.Fatal("exact identity refusal missing")
	}
	state := agent.State{Phase: agent.Blocked, Code: "policy_restricted"}
	if !bridgeConfirmedRestriction(state, agent.ErrLeaseBlocked) {
		t.Fatal("verified restriction missing")
	}
	for _, err := range []error{nil, context.DeadlineExceeded, agent.ErrUnknownRuntime} {
		if bridgeConfirmedRestriction(state, err) {
			t.Fatal("unrelated stop result accepted")
		}
	}
	for _, bad := range []agent.State{{Phase: agent.Unknown, Code: "policy_restricted"}, {Phase: agent.Blocked, Code: "policy_restriction_unobserved"}, {Phase: agent.Blocked, Code: "policy_restricted", RecoveryRequired: true}, {Phase: agent.Blocked, Code: "policy_restricted", Observed: &agent.Observation{}}} {
		if bridgeConfirmedRestriction(bad, agent.ErrLeaseBlocked) {
			t.Fatal("unverified stop accepted")
		}
	}
}

// Only the native supervisor's uncertain activation followed by a successful
// Recover with confirmed absence qualifies. Unknown, stale or still-running
// outcomes fail this test command rather than being relabeled as apply failure.
func bridgeStartupUnknown(state agent.State, err error) bool {
	return errors.Is(err, agent.ErrUnknownRuntime) && state.Phase == agent.Unknown && state.Code == "activation_outcome_unknown" && state.NativeChecked && state.Observed == nil && state.RecoveryRequired
}
func bridgeRecoveredAbsence(state agent.State) bool {
	return state.Phase == agent.ApplyFailed && state.Code == "recovered_not_applied" && state.NativeChecked && state.Observed == nil && !state.RecoveryRequired
}

// These summaries are read from the same owned durable root before and after
// correction. Never return raw snapshots (which include account bindings), or
// modify a marker to make a later activation possible.
type bridgeJournalSnapshot struct {
	Kind         string `json:"kind"`
	CounterEpoch string `json:"counterEpoch"`
	SHA256       string `json:"sha256"`
	ActiveFlows  int    `json:"activeFlows"`
	CounterCount int    `json:"counterCount"`
}
type bridgeJournalEvidence struct {
	RootWitness  string                  `json:"rootWitness"`
	RunningEpoch string                  `json:"runningEpoch,omitempty"`
	Snapshots    []bridgeJournalSnapshot `json:"snapshots"`
}

func bridgeReadJournal(root string) (*bridgeJournalEvidence, error) {
	dir := agent.ManagedJournalDirectory(root)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	if len(entries) > 16 {
		return nil, errors.New("unexpected fixture journal size")
	}
	rootSum := sha256.Sum256([]byte(dir))
	out := &bridgeJournalEvidence{RootWitness: hex.EncodeToString(rootSum[:]), Snapshots: []bridgeJournalSnapshot{}}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("fixture journal entry is not a regular file")
		}
		f, err := os.Open(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		content, readErr := io.ReadAll(io.LimitReader(f, (4<<20)+1))
		closeErr := f.Close()
		if readErr != nil || closeErr != nil || len(content) > 4<<20 {
			return nil, errors.New("fixture journal entry unreadable or oversized")
		}
		if entry.Name() == "running.json" {
			var marker struct {
				CounterEpoch string `json:"counterEpoch"`
			}
			if json.Unmarshal(content, &marker) != nil || marker.CounterEpoch == "" {
				return nil, errors.New("invalid fixture running epoch")
			}
			out.RunningEpoch = marker.CounterEpoch
			continue
		}
		kind := ""
		for _, candidate := range []string{"baseline", "final"} {
			if strings.HasSuffix(entry.Name(), "."+candidate+".json") {
				kind = candidate
			}
		}
		var snapshot entrypolicy.Snapshot
		if kind == "" || json.Unmarshal(content, &snapshot) != nil || snapshot.CounterEpoch == "" || entry.Name() != snapshot.CounterEpoch+"."+kind+".json" {
			return nil, errors.New("invalid fixture epoch snapshot")
		}
		sum := sha256.Sum256(content)
		out.Snapshots = append(out.Snapshots, bridgeJournalSnapshot{Kind: kind, CounterEpoch: snapshot.CounterEpoch, SHA256: hex.EncodeToString(sum[:]), ActiveFlows: snapshot.ActiveFlows, CounterCount: len(snapshot.Counters)})
	}
	return out, nil
}
