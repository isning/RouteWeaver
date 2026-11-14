//go:build linux

package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRawCoreLogsOwnedNativeProcessOutput(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" {
		t.Skip("explicit native binaries required")
	}
	for _, tc := range []struct{ id, version, binary, config string }{
		{"routeweaver/xray", "26.10.31", "xray", `{"log":{"loglevel":"info"},"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`},
		{"routeweaver/sing-box", "1.14.4", "sing-box", `{"log":{"level":"info"},"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`},
	} {
		t.Run(tc.binary, func(t *testing.T) {
			d := nativeDesired(t, tc.id, tc.version)
			d.Artifacts[0].Content = tc.config
			d.Digest, _ = ArtifactDigest(d.Artifacts)
			capture, e := OpenRawCoreLogs(d.Scope)
			if e != nil {
				t.Fatal(e)
			}
			defer capture.Close()
			checker, e := NewNativeChecker(tc.id, tc.version, filepath.Join(dir, tc.binary+"-"+tc.version+"-linux-amd64"), 5*time.Second)
			if e != nil {
				t.Fatal(e)
			}
			supervisor, e := NewProcessSupervisor(checker, SupervisorOptions{RawCoreLogs: capture, AllowLocalProcess: true, StartupGrace: 200 * time.Millisecond, StopTimeout: time.Second})
			if e != nil {
				t.Fatal(e)
			}
			root := t.TempDir()
			r := openTest(t, root, supervisor)
			defer supervisor.Stop(context.Background(), root)
			state, submitErr := r.Submit(context.Background(), d)
			// A sandbox-denied sing-box netlink startup is real failure output, not success.
			if tc.binary == "xray" && (submitErr != nil || state.Observed == nil) {
				t.Fatalf("xray startup: %v %+v", submitErr, state)
			}
			recv := &rawReceiver{}
			if e = capture.Flush(context.Background(), recv); e != nil {
				t.Fatal(e)
			}
			found := false
			for _, event := range recv.reports[0].Events {
				if event.AdapterID == tc.id && (strings.Contains(event.Text, "started") || strings.Contains(event.Text, "netlink") || strings.Contains(event.Text, "Xray")) {
					found = true
				}
			}
			if !found {
				t.Fatalf("no actual startup output; state=%s err=%v reports=%+v", state.Phase, submitErr, recv.reports)
			}
		})
	}
}
