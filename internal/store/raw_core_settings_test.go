package store_test

import (
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func TestRawCoreSettingsDefaultCASClearAndABA(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	p, e := s.RawCoreSettings("one")
	if e != nil || p.Enabled || p.Revision != "" {
		t.Fatalf("default %+v %v", p, e)
	}
	r := diagnostics.RawCoreReport{PolicyRevision: "unknown", Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "v", Stream: "stderr", Text: "sensitive", ObservedAt: now}}}
	s.Put("instance-enrollments", "one", map[string]any{"scope": r.Scope, "expiresAt": now.Add(10 * 24 * time.Hour)})
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e = s.AcceptRawCoreLogs(r, now); !errors.Is(e, diagnostics.ErrRawCoreConflict) {
		t.Fatal(e)
	}
	p, e = s.SetRawCoreSettings("one", "", true, 86400)
	if e != nil {
		t.Fatal(e)
	}
	r.PolicyRevision = p.Revision
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e = s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	if _, e = s.SetRawCoreSettings("one", "", false, 3600); !errors.Is(e, diagnostics.ErrRawCoreConflict) {
		t.Fatal(e)
	}
	h, e := s.RawCoreLogs("one", now.Add(2*time.Hour))
	if e != nil || len(h.Events) != 1 {
		t.Fatalf("24h %+v %v", h, e)
	}
	off, e := s.SetRawCoreSettings("one", p.Revision, false, 86400)
	if e != nil {
		t.Fatal(e)
	}
	h, e = s.RawCoreLogs("one", now)
	if e != nil || len(h.Events) != 0 {
		t.Fatal("not cleared", e)
	}
	on, e := s.SetRawCoreSettings("one", off.Revision, true, 604800)
	if e != nil || on.Revision == p.Revision {
		t.Fatal(e)
	}
	if _, e = s.AcceptRawCoreLogs(r, now.Add(time.Minute)); !errors.Is(e, diagnostics.ErrRawCoreConflict) {
		t.Fatal("ABA", e)
	}
	r.PolicyRevision = on.Revision
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e = s.AcceptRawCoreLogs(r, now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	h, e = s.RawCoreLogs("one", now.Add(6*24*time.Hour))
	if e != nil || len(h.Events) != 1 {
		t.Fatalf("7d retention %d %v", len(h.Events), e)
	}
	h, e = s.RawCoreLogs("one", now.Add(8*24*time.Hour))
	if e != nil || len(h.Events) != 0 {
		t.Fatalf("7d expiry %d %v", len(h.Events), e)
	}
	if _, e = s.SetRawCoreSettings("one", on.Revision, true, 1); e == nil {
		t.Fatal("bad retention")
	}
}

func TestRawCoreSettingsConcurrentDisableNeverRevivesBody(t *testing.T) {
	s, path, key, now := diagnosticStoreFixture(t)
	other, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	p, e := s.SetRawCoreSettings("one", "", true, 604800)
	if e != nil {
		t.Fatal(e)
	}
	r := diagnostics.RawCoreReport{PolicyRevision: p.Revision, Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1, Events: []diagnostics.RawCoreEvent{{AdapterID: "routeweaver/xray", Version: "v", Stream: "stderr", Text: "sensitive", ObservedAt: now}}}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	var wg sync.WaitGroup
	wg.Add(2)
	start := make(chan struct{})
	errs := make(chan error, 2)
	go func() {
		defer wg.Done()
		<-start
		_, e := s.AcceptRawCoreLogs(r, now)
		if e != nil && !errors.Is(e, diagnostics.ErrRawCoreConflict) {
			errs <- e
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		_, e := other.SetRawCoreSettings("one", p.Revision, false, 604800)
		if e != nil {
			errs <- e
		}
	}()
	close(start)
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	h, settings, e := s.RawCoreLogsWithSettings("one", now)
	if e != nil || settings.Enabled || len(h.Events) != 0 {
		t.Fatalf("revived %+v %+v %v", settings, h, e)
	}
}

func TestRawCoreSettingsRemovedWithInstance(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	p, e := s.SetRawCoreSettings("one", "", true, 3600)
	if e != nil {
		t.Fatal(e)
	}
	r := diagnostics.RawCoreReport{PolicyRevision: p.Revision, Scope: domain.InstanceScope{NodeID: "node", InstanceID: "one", EnrollmentEpoch: "epoch"}, Session: "session", Sequence: 1}
	r.Digest = diagnostics.RawCoreReportDigest(r)
	if _, e = s.AcceptRawCoreLogs(r, now); e != nil {
		t.Fatal(e)
	}
	if e = s.Remove("core-instances", "one"); e != nil {
		t.Fatal(e)
	}
	var value any
	for _, kind := range []string{"raw-core-log-settings", "raw-core-log-history"} {
		if e = s.Get(kind, "one", &value); e != store.ErrNotFound {
			t.Fatalf("retained %s %v", kind, e)
		}
	}
	if e = s.Put("core-instances", "one", domain.CoreInstance{ID: "one", HostID: "node"}); e != nil {
		t.Fatal(e)
	}
	fresh, e := s.RawCoreSettings("one")
	if e != nil || fresh.Enabled || fresh.Revision != "" {
		t.Fatalf("inherited %+v %v", fresh, e)
	}
}
