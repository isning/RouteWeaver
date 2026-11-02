package httpapi_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"testing"
)

func TestOperationalLifecycleRejectsUnrelatedFailureAndUnknownStop(t *testing.T) {
	for _, err := range []error{nil, context.Canceled, errors.New("503"), &agent.TransportError{Status: 500, Code: "request_rejected"}, &agent.TransportError{Status: 503, Code: "response_read_failed"}} {
		if operationalExpectedOutage(err) {
			t.Fatalf("accepted unrelated error: %v", err)
		}
	}
	if !operationalExpectedOutage(fmt.Errorf("wrapped: %w", &agent.TransportError{Status: 503, Code: "request_rejected"})) {
		t.Fatal("typed injected outage rejected")
	}
	good := agent.State{Phase: "stopped", Code: "local_session_stopped"}
	if !operationalStoppedState(good) {
		t.Fatal("owned stopped state rejected")
	}
	for _, bad := range []agent.State{{Phase: "stopped", Code: "local_session_stopped", Observed: &controlprotocol.Observation{}}, {Phase: "unknown", Code: "local_session_stopped"}, {Phase: "stopped", Code: "other"}, {Phase: "stopped", Code: "local_session_stopped", RecoveryRequired: true}} {
		if operationalStoppedState(bad) {
			t.Fatalf("unsafe stop accepted: %+v", bad)
		}
	}
}

func TestOperationalFinalGuardRejectsCurrentBaselineWithOldFinal(t *testing.T) {
	root := t.TempDir()
	dir := agent.ManagedJournalDirectory(root)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"current.baseline.json", "older.final.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(`{}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := operationalRetainedProof(root, controlprotocol.Scope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment"}, "current"); err == nil {
		t.Fatal("old final substituted for tracked runtime final")
	}
}
