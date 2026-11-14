package diagnostics_test

import (
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"strings"
	"testing"
	"time"
)

func TestRawCoreReportRejectsUnboundedUnscopedAndInvalidInput(t *testing.T) {
	now := time.Now().UTC()
	base := diagnostics.RawCoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/managed-xray", Version: "version", Stream: "stderr", Text: "unredacted", ObservedAt: now}}}
	for _, mutate := range []func(*diagnostics.RawCoreReport){func(r *diagnostics.RawCoreReport) { r.Scope.NodeID = "" }, func(r *diagnostics.RawCoreReport) { r.Session = "" }, func(r *diagnostics.RawCoreReport) { r.Events[0].Text = strings.Repeat("a", 4097) }, func(r *diagnostics.RawCoreReport) { r.Events[0].Text = string([]byte{255}) }, func(r *diagnostics.RawCoreReport) { r.Events[0].Stream = "info" }, func(r *diagnostics.RawCoreReport) { r.Events[0].ObservedAt = now.Add(6 * time.Minute) }, func(r *diagnostics.RawCoreReport) { r.Events = make([]diagnostics.RawCoreEvent, 17) }} {
		r := base
		r.Events = append([]diagnostics.RawCoreEvent{}, base.Events...)
		mutate(&r)
		r.Digest = diagnostics.RawCoreReportDigest(r)
		if r.Validate(now) == nil {
			t.Fatalf("invalid accepted %+v", r)
		}
	}
	base.Digest = diagnostics.RawCoreReportDigest(base)
	if e := base.Validate(now); e != nil {
		t.Fatal(e)
	}
}
