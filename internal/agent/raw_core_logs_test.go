package agent

import (
	"context"
	"errors"
	"routeweaver/internal/diagnostics"
	"strings"
	"testing"
	"time"
)

type rawReceiver struct {
	reports []diagnostics.RawCoreReport
	fail    bool
}

func (r *rawReceiver) ReportRawCoreLogs(_ context.Context, b diagnostics.RawCoreReport) (diagnostics.RawCoreReceipt, error) {
	r.reports = append(r.reports, b)
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
	out := w.NewWriter("routeweaver/xray", "26.3.27", "stderr")
	raw := "secret://credential@example.com <script>alert(1)</script>\x1b[31m"
	out.Write([]byte(raw + "\n"))
	recv := &rawReceiver{fail: true}
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
	out := w.NewWriter("routeweaver/xray", "26.3.27", "stdout")
	out.Write([]byte(strings.Repeat("x", 4097) + "\n"))
	out.Write([]byte{255, '\n'})
	out.Write([]byte("good\n"))
	out.Write([]byte(strings.Repeat("x", 65537)))
	now = now.Add(time.Second)
	out.Write([]byte("discard-tail\ngood2\n"))
	out.Close()
	recv := &rawReceiver{}
	if e := w.Flush(context.Background(), recv); e != nil {
		t.Fatal(e)
	}
	r := recv.reports[0]
	if len(r.Events) != 2 || r.Events[0].Text != "good" || r.Events[1].Text != "good2" || r.Dropped < 3 {
		t.Fatalf("bad drops %+v", r)
	}
}
