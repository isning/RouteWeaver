package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/diagnostics"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type rawReceiver struct {
	reports     []diagnostics.RawCoreReport
	fail        bool
	settings    *diagnostics.RawCoreSettings
	settingsErr bool
	reportErr   error
}

func (r *rawReceiver) RawCoreLogSettings(context.Context) (diagnostics.RawCoreSettings, error) {
	if r.settingsErr {
		return diagnostics.RawCoreSettings{}, errors.New("settings offline")
	}
	if r.settings != nil {
		return *r.settings, nil
	}
	return diagnostics.RawCoreSettings{InstanceID: "core", Enabled: true, RetentionSeconds: 3600, Revision: "policy1", HistoryLimit: 128, LineBytesLimit: 4096}, nil
}
func primeRawCollector(t *testing.T, w *RawCoreLogs, r *rawReceiver) {
	t.Helper()
	if e := w.Flush(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	r.reports = nil
}

func (r *rawReceiver) ReportRawCoreLogs(_ context.Context, b diagnostics.RawCoreReport) (diagnostics.RawCoreReceipt, error) {
	r.reports = append(r.reports, b)
	if r.reportErr != nil {
		return diagnostics.RawCoreReceipt{}, r.reportErr
	}
	if r.fail {
		return diagnostics.RawCoreReceipt{}, errors.New("offline")
	}
	return diagnostics.RawCoreReceipt{Sequence: b.Sequence, Digest: b.Digest}, nil
}
func TestRawCoreLogsDefaultOffAndSensitiveMemoryReplay(t *testing.T) {
	var off *RawCoreLogs
	off.NewWriter("routeweaver/xray", "26.3.27", "stderr").Write([]byte("secret\n"))
	w, e := OpenRawCoreLogs(Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
	if e != nil {
		t.Fatal(e)
	}
	defer w.Close()
	recv := &rawReceiver{}
	primeRawCollector(t, w, recv)
	out := w.NewWriter("routeweaver/xray", "26.3.27", "stderr")
	raw := "secret://credential@example.com <script>alert(1)</script>\x1b[31m"
	out.Write([]byte(raw + "\n"))
	recv.fail = true
	if w.Flush(context.Background(), recv) == nil {
		t.Fatal("offline acknowledged")
	}
	recv.fail = false
	if e = w.Flush(context.Background(), recv); e != nil {
		t.Fatal(e)
	}
	if recv.reports[0].Digest != recv.reports[1].Digest || recv.reports[1].Events[0].Text != raw {
		t.Fatal("raw/replay mismatch")
	}
	old := recv.reports[1].Session
	w.Close()
	next, _ := OpenRawCoreLogs(w.scope)
	defer next.Close()
	fresh := &rawReceiver{}
	next.Flush(context.Background(), fresh)
	if fresh.reports[0].Session == old || len(fresh.reports[0].Events) != 0 {
		t.Fatal("restart must not retain memory logs")
	}
}
func TestRawCoreLogsDropsOverlongInvalidAndFlood(t *testing.T) {
	w, _ := OpenRawCoreLogs(Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
	defer w.Close()
	now := time.Now()
	w.now = func() time.Time { return now }
	recv := &rawReceiver{}
	primeRawCollector(t, w, recv)
	out := w.NewWriter("routeweaver/xray", "26.3.27", "stdout")
	out.Write([]byte(strings.Repeat("x", 4097) + "\n"))
	out.Write([]byte{255, '\n'})
	out.Write([]byte("good\n"))
	out.Write([]byte(strings.Repeat("x", 65537)))
	now = now.Add(time.Second)
	out.Write([]byte("discard-tail\ngood2\n"))
	out.Close()
	out.Write([]byte("must-discard-after-close\n"))
	if e := w.Flush(context.Background(), recv); e != nil {
		t.Fatal(e)
	}
	r := recv.reports[0]
	if len(r.Events) != 2 || r.Events[0].Text != "good" || r.Events[1].Text != "good2" || r.Dropped < 3 {
		t.Fatalf("bad drops %+v", r)
	}
}

func TestRawCorePolicyStopsAndPurgesPendingAndPartialLines(t *testing.T) {
	w, _ := OpenRawCoreLogs(Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
	defer w.Close()
	out := w.NewWriter("routeweaver/xray", "v", "stdout")
	defer out.Close()
	out.Write([]byte("before-consent\n"))
	recv := &rawReceiver{}
	primeRawCollector(t, w, recv)
	if len(w.queue) != 0 {
		t.Fatal("pre-policy output collected")
	}
	out.Write([]byte("old-secret\npartial-secret"))
	recv.fail = true
	if w.Flush(context.Background(), recv) == nil {
		t.Fatal("expected offline")
	}
	before := w.delivery.Session
	settings, _ := recv.RawCoreLogSettings(context.Background())
	settings.Enabled = false
	settings.Revision = "disabled2"
	recv.settings = &settings
	recv.fail = false
	count := len(recv.reports)
	if e := w.Flush(context.Background(), recv); e != nil {
		t.Fatal(e)
	}
	if len(recv.reports) != count || len(w.queue) != 0 || w.delivery.Pending != nil || len(out.(*rawCoreLineWriter).line) != 0 {
		t.Fatal("pause retained or transmitted raw content")
	}
	out.Write([]byte("paused-secret\n"))
	settings.Enabled = true
	settings.Revision = "enabled3"
	primeRawCollector(t, w, recv)
	out.Write([]byte("new-output\n"))
	if e := w.Flush(context.Background(), recv); e != nil {
		t.Fatal(e)
	}
	if len(recv.reports) != 1 || len(recv.reports[0].Events) != 1 || recv.reports[0].Events[0].Text != "new-output" || recv.reports[0].PolicyRevision != "enabled3" || recv.reports[0].Session == before {
		t.Fatalf("old batch revived %+v", recv.reports)
	}
}

func TestRawCorePolicyFailureIsClosedAndRevisionRejectDropsPending(t *testing.T) {
	for _, mode := range []string{"unreachable", "wrong-instance", "invalid-retention", "empty-revision", "stale-post"} {
		t.Run(mode, func(t *testing.T) {
			w, _ := OpenRawCoreLogs(Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
			defer w.Close()
			recv := &rawReceiver{}
			primeRawCollector(t, w, recv)
			out := w.NewWriter("routeweaver/xray", "v", "stderr")
			defer out.Close()
			out.Write([]byte("secret\npartial"))
			settings, _ := recv.RawCoreLogSettings(context.Background())
			recv.settings = &settings
			switch mode {
			case "unreachable":
				recv.settingsErr = true
			case "wrong-instance":
				settings.InstanceID = "other"
			case "invalid-retention":
				settings.RetentionSeconds = 0
			case "empty-revision":
				settings.Revision = ""
			case "stale-post":
				recv.reportErr = &TransportError{Status: 409}
			}
			if w.Flush(context.Background(), recv) == nil {
				t.Fatal("unsafe policy accepted")
			}
			if w.captureRevision() != "" || len(w.queue) != 0 || w.delivery.Pending != nil || len(out.(*rawCoreLineWriter).line) != 0 {
				t.Fatal("failed policy retained raw state")
			}
		})
	}
}

func TestRawCorePolicyConcurrentPauseAndWriter(t *testing.T) {
	w, _ := OpenRawCoreLogs(Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"})
	defer w.Close()
	recv := &rawReceiver{}
	primeRawCollector(t, w, recv)
	out := w.NewWriter("routeweaver/xray", "v", "stdout")
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer out.Close()
		for i := 0; i < 300; i++ {
			out.Write([]byte("line\npartial"))
		}
	}()
	settings, _ := recv.RawCoreLogSettings(context.Background())
	recv.settings = &settings
	for i := 0; i < 20; i++ {
		settings.Enabled = i%2 == 0
		settings.Revision = fmt.Sprintf("policy%d", i+2)
		if e := w.Flush(context.Background(), recv); e != nil {
			t.Fatal(e)
		}
	}
	<-done
	settings.Enabled = false
	settings.Revision = "final-off"
	w.Flush(context.Background(), recv)
	if len(w.queue) != 0 || w.delivery.Pending != nil || len(w.writers) != 0 {
		t.Fatal("raw state or writer registration retained")
	}
}

func TestRawCoreHTTPInvalidReceiptPurgesCollection(t *testing.T) {
	for _, mode := range []string{"decode", "mismatch"} {
		t.Run(mode, func(t *testing.T) {
			var bad atomic.Bool
			srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				rw.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					json.NewEncoder(rw).Encode(diagnostics.RawCoreSettings{InstanceID: "core", Enabled: true, Revision: "policy1", RetentionSeconds: 3600, HistoryLimit: 128, LineBytesLimit: 4096})
					return
				}
				var report diagnostics.RawCoreReport
				if e := json.NewDecoder(r.Body).Decode(&report); e != nil {
					t.Error(e)
					return
				}
				if bad.Load() {
					if mode == "decode" {
						rw.Write([]byte(`{"invalid`))
						return
					}
					json.NewEncoder(rw).Encode(diagnostics.RawCoreReceipt{Sequence: report.Sequence, Digest: "wrong"})
					return
				}
				json.NewEncoder(rw).Encode(diagnostics.RawCoreReceipt{Sequence: report.Sequence, Digest: report.Digest})
			}))
			defer srv.Close()
			scope := Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
			tr, e := NewHTTPTransport(HTTPTransportOptions{BaseURL: srv.URL, Scope: scope, Token: "test-token", RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
			if e != nil {
				t.Fatal(e)
			}
			defer tr.Close()
			w, _ := OpenRawCoreLogs(scope)
			defer w.Close()
			if e = w.Flush(context.Background(), tr); e != nil {
				t.Fatal(e)
			}
			out := w.NewWriter("routeweaver/xray", "v", "stderr")
			defer out.Close()
			out.Write([]byte("secret\npartial"))
			bad.Store(true)
			if e = w.Flush(context.Background(), tr); !errors.Is(e, errInvalidRawCoreReceipt) {
				t.Fatal(e)
			}
			if w.captureRevision() != "" || len(w.queue) != 0 || w.delivery.Pending != nil || len(out.(*rawCoreLineWriter).line) != 0 {
				t.Fatal("invalid real HTTP receipt retained collection")
			}
		})
	}
}
