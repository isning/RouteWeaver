package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/agent"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"strings"
	"testing"
	"time"
)

type coreReceiver struct {
	reports []diagnostics.CoreReport
	fail    bool
}

func (r *coreReceiver) ReportCoreDiagnostics(_ context.Context, b diagnostics.CoreReport) (diagnostics.CoreReceipt, error) {
	r.reports = append(r.reports, b)
	if r.fail {
		return diagnostics.CoreReceipt{}, errors.New("unavailable")
	}
	return diagnostics.CoreReceipt{Sequence: b.Sequence, Digest: b.Digest}, nil
}

const certificateFailure = "Failed to start: main: failed to load config files: [/private/credential.json] > infra/conf: failed to build inbound config with tag SECRET > infra/conf: Failed to build TLS config. > infra/conf: failed to parse certificate > open /private/secret.pem: no such file or directory"

func TestCoreDiagnosticsCaptureIsBoundedPrivateAndReplayedAfterRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "diagnostics")
	scope := agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	w, e := agent.OpenCoreDiagnostics(root, scope)
	if e != nil {
		t.Fatal(e)
	}
	writer := w.NewWriter("routeweaver/xray", "26.3.27")
	io.WriteString(writer, certificateFailure[:50])
	io.WriteString(writer, certificateFailure[50:]+"\n")
	io.WriteString(writer, "from tcp:PRIVATE:12 accepted tcp:SECRET:443\n")
	io.WriteString(writer, strings.Repeat("private", 1000)+"\n")
	writer.Close()
	r := &coreReceiver{fail: true}
	if e = w.Flush(context.Background(), r); e == nil {
		t.Fatal("missing transport failure")
	}
	original := r.reports[0]
	if len(original.Events) != 1 || original.Events[0].Code != "tls_certificate_file_missing" || original.Omitted != 1 || original.Dropped != 1 {
		t.Fatalf("capture %+v", original)
	}
	b, _ := json.Marshal(original)
	disk, _ := os.ReadFile(filepath.Join(root, "core-diagnostics.json"))
	for _, secret := range []string{"PRIVATE", "SECRET", "/private/", "accepted"} {
		if strings.Contains(string(b), secret) || strings.Contains(string(disk), secret) {
			t.Fatal("raw output escaped")
		}
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	w, e = agent.OpenCoreDiagnostics(root, scope)
	if e != nil {
		t.Fatal(e)
	}
	defer w.Close()
	r.fail = false
	if e = w.Flush(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	if r.reports[1].Digest != original.Digest || r.reports[1].Sequence != original.Sequence {
		t.Fatal("pending retry changed")
	}
	unsupported := w.NewWriter("routeweaver/managed-xray", "26.2.6")
	io.WriteString(unsupported, certificateFailure+"\n")
	unsupported.Close()
	if e = w.Flush(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	if r.reports[2].Sequence != 2 || len(r.reports[2].Events) != 0 {
		t.Fatal("unsupported version or sequence")
	}
}
func TestCoreDiagnosticsNativeValidationCapturesCategoryNotRawError(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "core")
	script := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'Xray 26.3.27'; exit 0; fi\nprintf '%s\\n' '" + certificateFailure + "'\nexit 1\n"
	if e := os.WriteFile(binary, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	scope := agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	w, e := agent.OpenCoreDiagnostics(filepath.Join(root, "diagnostics"), scope)
	if e != nil {
		t.Fatal(e)
	}
	defer w.Close()
	checker, e := agent.NewNativeChecker("routeweaver/xray", "26.3.27", binary, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	supervisor, e := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{CoreDiagnostics: w, AllowLocalProcess: true, StartupGrace: time.Millisecond, StopTimeout: time.Second})
	if e != nil {
		t.Fatal(e)
	}
	d := agent.Desired{Scope: scope, AdapterID: "routeweaver/xray", CoreVersion: "26.3.27", EntryFile: "config.json", Artifacts: []domain.Artifact{{Path: "config.json", Content: "{}"}}}
	if e = supervisor.Validate(context.Background(), agent.Staged{Desired: d, Directory: root, Root: root}); e == nil {
		t.Fatal("bad check succeeded")
	}
	if strings.Contains(e.Error(), "secret") {
		t.Fatal("raw error returned")
	}
	r := &coreReceiver{}
	if e = w.Flush(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	if len(r.reports[0].Events) != 1 || r.reports[0].Events[0].Code != "tls_certificate_file_missing" {
		t.Fatalf("missing category %+v", r.reports)
	}
}
func TestCoreDiagnosticsFloodDoesNotGrowPendingOrBlockWriters(t *testing.T) {
	w, e := agent.OpenCoreDiagnostics(filepath.Join(t.TempDir(), "diagnostics"), agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
	if e != nil {
		t.Fatal(e)
	}
	defer w.Close()
	for n := 0; n < 400; n++ {
		writer := w.NewWriter("routeweaver/xray", "26.3.27")
		io.WriteString(writer, certificateFailure+"\n")
		writer.Close()
	}
	r := &coreReceiver{}
	for n := 0; n < 5; n++ {
		if e = w.Flush(context.Background(), r); e != nil {
			t.Fatal(e)
		}
	}
	total := 0
	for _, report := range r.reports {
		if len(report.Events) > 32 {
			t.Fatal("batch grew")
		}
		total += len(report.Events)
	}
	if total != 128 || r.reports[0].Dropped != 272 {
		t.Fatalf("not bounded total=%d dropped=%d", total, r.reports[0].Dropped)
	}
}

func TestCoreDiagnosticsRejectOversizedOrPublicJournal(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		mode os.FileMode
	}{{"oversized", 32769, 0600}, {"public", 2, 0644}} {
		t.Run(tc.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "diagnostics")
			os.Mkdir(root, 0700)
			if err := os.WriteFile(filepath.Join(root, "core-diagnostics.json"), []byte(strings.Repeat(" ", tc.size)), tc.mode); err != nil {
				t.Fatal(err)
			}
			w, err := agent.OpenCoreDiagnostics(root, agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
			if err == nil {
				w.Close()
				t.Fatal("unsafe journal accepted")
			}
		})
	}
}
