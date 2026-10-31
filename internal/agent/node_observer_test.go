package agent_test

import (
	"context"
	"errors"
	"os"
	"routeweaver/internal/agent"
	"routeweaver/internal/observability"
	"strings"
	"testing"
	"testing/fstest"
)

func procFixture() fstest.MapFS {
	return fstest.MapFS{
		"stat":                      {Data: []byte("cpu  100 20 50 700 30 10 20 5 40 4\ncpu0 1 2 3 4\n")},
		"meminfo":                   {Data: []byte("MemTotal: 1024 kB\nMemFree: 123 kB\nMemAvailable: 400 kB\n")},
		"loadavg":                   {Data: []byte("0.20 1.50 2.75 1/100 1234\n")},
		"net/dev":                   {Data: []byte("Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n lo: 900 1 0 0 0 0 0 0 900 1 0 0 0 0 0 0\n")},
		"sys/kernel/random/boot_id": {Data: []byte("01234567-0123-0123-0123-012345678901\n")},
	}
}
func TestNodeCollectorReadsNamedCountersAndExcludesCPUGuestDoubleCount(t *testing.T) {
	metrics, e := agent.NewNodeCollector(procFixture()).Collect(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if metrics.CPUTotalTicks != 935 || metrics.CPUIdleTicks != 730 || metrics.MemoryTotalBytes != 1048576 || metrics.MemoryAvailableBytes != 409600 || metrics.Load15 != 2.75 {
		t.Fatalf("wrong procfs measurements: %+v", metrics)
	}
	if len(metrics.Interfaces) != 2 || metrics.Interfaces[0].Name != "eth0" || metrics.Interfaces[0].ReceiveBytes != 100 || metrics.Interfaces[1].Name != "lo" {
		t.Fatalf("NIC names/counters lost: %+v", metrics.Interfaces)
	}
}
func TestNodeCollectorRejectsMissingMalformedOrUnboundedFacts(t *testing.T) {
	for _, name := range []string{"stat", "meminfo", "loadavg", "net/dev", "sys/kernel/random/boot_id"} {
		t.Run(name, func(t *testing.T) {
			f := procFixture()
			delete(f, name)
			if _, e := agent.NewNodeCollector(f).Collect(context.Background()); e == nil {
				t.Fatal("missing resource returned as healthy zero")
			}
		})
	}
	f := procFixture()
	f["meminfo"] = &fstest.MapFile{Data: []byte("MemTotal: 1024 kB\n")}
	if _, e := agent.NewNodeCollector(f).Collect(context.Background()); e == nil {
		t.Fatal("missing available memory invented")
	}
	f = procFixture()
	f["net/dev"] = &fstest.MapFile{Data: []byte(strings.Repeat("x", 300000))}
	if _, e := agent.NewNodeCollector(f).Collect(context.Background()); e == nil {
		t.Fatal("oversize procfs accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := agent.NewNodeCollector(f).Collect(ctx); e == nil {
		t.Fatal("cancelled collection continued")
	}
}

type recordingNodeTransport struct {
	reports      []observability.Report
	fail         bool
	wrongReceipt bool
}

func (tr *recordingNodeTransport) ReportNodeObservation(_ context.Context, r observability.Report) (observability.Receipt, error) {
	tr.reports = append(tr.reports, r)
	if tr.fail {
		tr.fail = false
		return observability.Receipt{}, errors.New("synthetic transport failure")
	}
	receipt := observability.Receipt{StreamEpoch: r.StreamEpoch, Sequence: r.Sequence, Digest: r.Digest}
	if tr.wrongReceipt {
		receipt.Digest = "wrong"
	}
	return receipt, nil
}
func TestNodeObserverRetainsExactSampleUntilAcknowledged(t *testing.T) {
	scope := agent.Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "enr"}
	observer, e := agent.NewNodeObserver(scope, agent.NewNodeCollector(procFixture()))
	if e != nil {
		t.Fatal(e)
	}
	tr := &recordingNodeTransport{fail: true}
	if e = observer.Observe(context.Background(), tr); e == nil {
		t.Fatal("failed transport reported success")
	}
	if e = observer.Observe(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	if tr.reports[0].Digest != tr.reports[1].Digest || tr.reports[0].Sequence != 1 || !tr.reports[0].ObservedAt.Equal(tr.reports[1].ObservedAt) {
		t.Fatal("retry changed pending sample")
	}
	tr.wrongReceipt = true
	if e = observer.Observe(context.Background(), tr); e == nil {
		t.Fatal("wrong receipt acknowledged")
	}
	tr.wrongReceipt = false
	if e = observer.Observe(context.Background(), tr); e != nil {
		t.Fatal(e)
	}
	if tr.reports[2].Sequence != 2 || tr.reports[2].Digest != tr.reports[3].Digest {
		t.Fatal("receipt mismatch advanced stream")
	}
}
func TestLocalProcfsResourceReadOptIn(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_LOCAL_PROCFS") != "1" {
		t.Skip("optional real local read requires ROUTEWEAVER_LOCAL_PROCFS=1; synthetic procfs fixtures run normally")
	}
	c, e := agent.NewLocalNodeCollector()
	if e != nil {
		t.Fatal(e)
	}
	metrics, e := c.Collect(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if metrics.MemoryTotalBytes == 0 || metrics.CPUTotalTicks == 0 || len(metrics.Interfaces) == 0 {
		t.Fatal("local procfs facts unavailable")
	}
}
