package store_test

import (
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestRawCoreLogsAreScopedIdempotentBoundedAndExpire(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	r := diagnostics.RawCoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Stream: "stderr", Text: "original secret://test", ObservedAt: now}}}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	if receipt, e := s.AcceptRawCoreLogs(r, now); e != nil || !receipt.Duplicate {
		t.Fatalf("retry %v %v", receipt, e)
	}
	r.Events[0].Text = "different"
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); !errors.Is(e, diagnostics.ErrRawCoreConflict) {
		t.Fatalf("changed retry %v", e)
	}
	r.Scope.NodeID = "foreign"
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("foreign %v", e)
	}
	r.Scope.NodeID = "node"
	for n := uint64(2); n <= 140; n++ {
		r.Sequence = n
		r.Digest = diagnostics.RawCoreReportDigest(r)
		if _, e := s.AcceptRawCoreLogs(r, now.Add(time.Duration(n)*10*time.Second)); e != nil {
			t.Fatal(e)
		}
	}
	h, e := s.RawCoreLogs("one", now.Add(30*time.Minute))
	if e != nil || len(h.Events) != 128 {
		t.Fatalf("cap %d %v", len(h.Events), e)
	}
	s.Put("instance-enrollments", "one", map[string]any{"scope": r.Scope, "expiresAt": now.Add(48 * time.Hour)})
	if e := s.PruneRawCoreLogs(now.Add(26 * time.Hour)); e != nil {
		t.Fatal(e)
	}
	h, e = s.RawCoreLogs("one", now.Add(26*time.Hour))
	if e != nil || len(h.Events) != 0 || h.Sequence != 140 {
		t.Fatalf("retention lost fence %+v %v", h, e)
	}
	r.Sequence++
	r.Digest = diagnostics.RawCoreReportDigest(r)
	s.Put("instance-enrollments", "one", map[string]any{"scope": r.Scope, "expiresAt": now.Add(time.Hour), "revoked": true})
	if _, e := s.AcceptRawCoreLogs(r, now.Add(30*time.Minute)); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("revoked %v", e)
	}
}

func TestRawCoreLogsRejectRateAndInvalidDigest(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	r := diagnostics.RawCoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1}
	if _, e := s.AcceptRawCoreLogs(r, now); e == nil {
		t.Fatal("invalid digest accepted")
	}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	r.Sequence++
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now.Add(time.Second)); !errors.Is(e, diagnostics.ErrRawCoreRate) {
		t.Fatalf("rate: %v", e)
	}
	if _, e := s.AcceptRawCoreLogs(r, now.Add(5*time.Second)); e != nil {
		t.Fatal(e)
	}
}

func TestRawCoreLogsCorruptHistoryDoesNotBlockOtherRetention(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	scope := domain.InstanceScope{NodeID: "node", InstanceID: "two", EnrollmentEpoch: "epoch"}
	s.Put("instance-enrollments", "two", map[string]any{"scope": scope, "expiresAt": now.Add(48 * time.Hour)})
	r := diagnostics.RawCoreReport{Scope: scope, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Stream: "stderr", Text: "sensitive", ObservedAt: now}}}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("raw-core-log-history", "one", "not a history"); e != nil {
		t.Fatal(e)
	}
	if e := s.PruneRawCoreLogs(now.Add(2 * time.Hour)); e == nil {
		t.Fatal("corruption not reported")
	}
	// Read without invoking pruning to establish the cleanup, not GET, removed it.
	var stored diagnostics.RawCoreHistory
	if e := s.Get("raw-core-log-history", "two", &stored); e != nil || len(stored.Events) != 0 {
		t.Fatalf("cleanup not committed %+v %v", stored, e)
	}
}

func TestRawCoreLogsAgentRestartRetainsHistoryButRequiresFirstSequence(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	r := diagnostics.RawCoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "first", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Stream: "stdout", Text: "one", ObservedAt: now}}}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	r.Session = "restart"
	r.Sequence = 2
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now.Add(10*time.Second)); !errors.Is(e, diagnostics.ErrRawCoreConflict) {
		t.Fatalf("restart invalid sequence %v", e)
	}
	r.Sequence = 1
	r.Events[0].Text = "two"
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e := s.AcceptRawCoreLogs(r, now.Add(10*time.Second)); e != nil {
		t.Fatal(e)
	}
	h, e := s.RawCoreLogs("one", now.Add(11*time.Second))
	if e != nil || len(h.Events) != 2 || h.Events[0].Text != "one" || h.Events[1].Text != "two" {
		t.Fatalf("history %+v %v", h, e)
	}
}
