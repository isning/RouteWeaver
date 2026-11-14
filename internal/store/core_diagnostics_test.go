package store_test

import (
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestCoreDiagnosticsAreScopedIdempotentBoundedAndExpire(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	r := diagnostics.CoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Sequence: 1, Events: []diagnostics.CoreEvent{{AdapterID: "routeweaver/xray", Version: "26.3.27", Code: "listener_address_in_use", ObservedAt: now}}}
	r.Digest = diagnostics.CoreReportDigest(r)
	if _, e := s.AcceptCoreDiagnostics(r, now); e != nil {
		t.Fatal(e)
	}
	if receipt, e := s.AcceptCoreDiagnostics(r, now); e != nil || !receipt.Duplicate {
		t.Fatalf("retry %v %v", receipt, e)
	}
	r.Events[0].Code = "tls_certificate_file_missing"
	r.Digest = diagnostics.CoreReportDigest(r)
	if _, e := s.AcceptCoreDiagnostics(r, now); !errors.Is(e, diagnostics.ErrCoreConflict) {
		t.Fatalf("changed retry %v", e)
	}
	r.Scope.NodeID = "foreign"
	r.Digest = diagnostics.CoreReportDigest(r)
	if _, e := s.AcceptCoreDiagnostics(r, now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("foreign %v", e)
	}
	r.Scope.NodeID = "node"
	for n := uint64(2); n <= 140; n++ {
		r.Sequence = n
		r.Digest = diagnostics.CoreReportDigest(r)
		if _, e := s.AcceptCoreDiagnostics(r, now.Add(time.Duration(n)*10*time.Second)); e != nil {
			t.Fatal(e)
		}
	}
	h, e := s.CoreDiagnostics("one", now.Add(30*time.Minute))
	if e != nil || len(h.Events) != 128 {
		t.Fatalf("cap %d %v", len(h.Events), e)
	}
	s.Put("instance-enrollments", "one", map[string]any{"scope": r.Scope, "expiresAt": now.Add(48 * time.Hour)})
	if e := s.PruneCoreDiagnostics(now.Add(26 * time.Hour)); e != nil {
		t.Fatal(e)
	}
	h, e = s.CoreDiagnostics("one", now.Add(26*time.Hour))
	if e != nil || len(h.Events) != 0 || h.Sequence != 140 {
		t.Fatalf("retention lost fence %+v %v", h, e)
	}
	r.Sequence++
	r.Digest = diagnostics.CoreReportDigest(r)
	s.Put("instance-enrollments", "one", map[string]any{"scope": r.Scope, "expiresAt": now.Add(time.Hour), "revoked": true})
	if _, e := s.AcceptCoreDiagnostics(r, now.Add(30*time.Minute)); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("revoked %v", e)
	}
}

func TestCoreDiagnosticsRejectRateAndInvalidDigest(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	r := diagnostics.CoreReport{Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Sequence: 1}
	if _, e := s.AcceptCoreDiagnostics(r, now); e == nil {
		t.Fatal("invalid digest accepted")
	}
	r.Digest = diagnostics.CoreReportDigest(r)
	if _, e := s.AcceptCoreDiagnostics(r, now); e != nil {
		t.Fatal(e)
	}
	r.Sequence++
	r.Digest = diagnostics.CoreReportDigest(r)
	if _, e := s.AcceptCoreDiagnostics(r, now.Add(time.Second)); !errors.Is(e, diagnostics.ErrCoreRate) {
		t.Fatalf("rate: %v", e)
	}
	if _, e := s.AcceptCoreDiagnostics(r, now.Add(5*time.Second)); e != nil {
		t.Fatal(e)
	}
}
