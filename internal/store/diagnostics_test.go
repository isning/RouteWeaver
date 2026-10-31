package store_test

import (
	"bytes"
	"errors"
	"path/filepath"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func diagnosticStoreFixture(t *testing.T) (*store.Store, string, []byte, time.Time) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.db")
	key := bytes.Repeat([]byte{9}, 32)
	s, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Now().UTC()
	for _, core := range []string{"one", "two"} {
		scope := controlprotocol.Scope{NodeID: "node", InstanceID: core, EnrollmentEpoch: "epoch"}
		for _, v := range []struct {
			k, id string
			v     any
		}{{"hosts", "node", domain.Host{ID: "node", Name: "Node"}}, {"core-instances", core, domain.CoreInstance{ID: core, HostID: "node"}}, {"instance-enrollments", core, map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour)}}} {
			if e = s.Put(v.k, v.id, v.v); e != nil {
				t.Fatal(e)
			}
		}
	}
	if e = s.CreateDiagnosticTarget(diagnostics.Target{ID: "target", Name: "Authorized public target", NodeID: "node", URL: "https://example.com/diagnostic", Methods: []string{"download"}}, "operator", now); e != nil {
		t.Fatal(e)
	}
	return s, path, key, now
}
func diagnosticStoreRequest(t *testing.T, s *store.Store, id, core string, now time.Time) diagnostics.Job {
	t.Helper()
	j, e := s.RequestDiagnostic(diagnostics.Request{ID: id, TargetID: "target", InstanceID: core, Kind: "download", MaxBytes: 4096, TimeoutSeconds: 2}, "operator", now)
	if e != nil {
		t.Fatal(e)
	}
	return j
}
func TestDiagnosticQueueAndClaimsSurviveRestartAndSerializeAcrossStoreHandles(t *testing.T) {
	s, path, key, now := diagnosticStoreFixture(t)
	a := diagnosticStoreRequest(t, s, "job-one", "one", now)
	b := diagnosticStoreRequest(t, s, "job-two", "two", now.Add(time.Millisecond))
	second, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	jobs, e := second.DiagnosticJobs(now)
	if e != nil || len(jobs) != 2 {
		t.Fatalf("durable queue %v %v", jobs, e)
	}
	var wg sync.WaitGroup
	results := make(chan *diagnostics.Job, 2)
	errs := make(chan error, 2)
	for i, j := range []diagnostics.Job{a, b} {
		wg.Add(1)
		go func(i int, j diagnostics.Job) {
			defer wg.Done()
			handle := s
			if i == 1 {
				handle = second
			}
			claimed, e := handle.ClaimDiagnostic(j.Scope, "attempt-"+j.ID, now.Add(time.Second))
			results <- claimed
			errs <- e
		}(i, j)
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var claimed *diagnostics.Job
	count := 0
	for r := range results {
		if r != nil {
			count++
			claimed = r
		}
	}
	if count != 1 {
		t.Fatalf("per-node concurrency violated %d", count)
	}
	replay, e := second.ClaimDiagnostic(claimed.Scope, claimed.AttemptID, now.Add(2*time.Second))
	if e != nil || replay == nil || replay.ID != claimed.ID {
		t.Fatalf("claim receipt replay %v %v", replay, e)
	}
	foreign := claimed.Scope
	foreign.InstanceID = "two"
	if claimed.Scope.InstanceID == "two" {
		foreign.InstanceID = "one"
	}
	if _, e = second.DiagnosticJobForScope(claimed.ID, foreign, now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("scope leaked %v", e)
	}
	result := diagnostics.Result{Status: "not_run", Phase: "authorization", Code: "target_denied", Action: "Configure an authorized target", StartedAt: now.Add(time.Second), FinishedAt: now.Add(time.Second), CostKnown: true}
	report := diagnostics.Report{JobID: claimed.ID, Scope: claimed.Scope, AttemptID: claimed.AttemptID, Result: result}
	bad := report
	bad.AttemptID = "replayed-old-attempt"
	if e = second.AcceptDiagnosticReport(bad, now.Add(2*time.Second)); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("attempt fence %v", e)
	}
	if e = second.AcceptDiagnosticReport(report, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	if e = s.AcceptDiagnosticReport(report, now.Add(2*time.Second)); e != nil {
		t.Fatal(e)
	}
	bad = report
	bad.Result.Code = "changed-result"
	if e = s.AcceptDiagnosticReport(bad, now.Add(2*time.Second)); !errors.Is(e, store.ErrConflict) {
		t.Fatalf("conflicting result %v", e)
	}
	if j, e := second.ClaimDiagnostic(foreign, "next-attempt", now.Add(3*time.Second)); e != nil || j == nil {
		t.Fatalf("completed job kept lane locked %v %v", j, e)
	}
}
func TestUnrunExpiredCancelledAndMissingResultsAreNeverSuccess(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	queued := diagnosticStoreRequest(t, s, "expired-job", "one", now)
	j, e := s.DiagnosticJob(queued.ID, now.Add(3*time.Minute))
	if e != nil || j.Status != "not_run" || j.Result == nil || !j.Result.CostKnown || j.Result.BytesPerSecond != nil {
		t.Fatalf("expired fabricated %+v %v", j, e)
	}
	queued = diagnosticStoreRequest(t, s, "cancelled-job", "one", now)
	j, e = s.CancelDiagnostic(queued.ID, "operator", now)
	if e != nil || j.Status != "not_run" || j.Result.Code != "cancelled_before_start" {
		t.Fatalf("cancelled fabricated %+v %v", j, e)
	}
	queued = diagnosticStoreRequest(t, s, "missing-job", "one", now)
	claimed, e := s.ClaimDiagnostic(queued.Scope, "attempt", now)
	if e != nil || claimed == nil {
		t.Fatal(e)
	}
	j, e = s.DiagnosticJob(queued.ID, now.Add(18*time.Second))
	if e != nil || j.Status != "unknown" || j.Result.CostKnown || j.Result.BytesPerSecond != nil {
		t.Fatalf("missing result fabricated %+v %v", j, e)
	}
	if again, e := s.ClaimDiagnostic(queued.Scope, "new-attempt", now.Add(20*time.Second)); e != nil || again != nil {
		t.Fatalf("uncertain traffic automatically retried %+v %v", again, e)
	}
}
func TestDiagnosticQueueBoundAndEnrollmentChange(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	var job diagnostics.Job
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		job = diagnosticStoreRequest(t, s, id, "one", now)
	}
	request := job.Request
	request.ID = "overflow"
	if _, e := s.RequestDiagnostic(request, "operator", now); e == nil {
		t.Fatal("unbounded queue accepted")
	}
	scope := job.Scope
	scope.EnrollmentEpoch = "new-epoch"
	if e := s.Put("instance-enrollments", scope.InstanceID, map[string]any{"scope": scope, "expiresAt": now.Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.ClaimDiagnostic(job.Scope, "old-attempt", now); !errors.Is(e, diagnostics.ErrScope) {
		t.Fatalf("old enrollment claimed %v", e)
	}
	jobs, e := s.DiagnosticJobs(now)
	if e != nil {
		t.Fatal(e)
	}
	for _, j := range jobs {
		if j.Status != "not_run" || j.Result.Code != "enrollment_changed" {
			t.Fatalf("old queued scope retained %+v", j)
		}
	}
}
func TestLateDurableResultRefinesUnknownWithoutReexecutingJob(t *testing.T) {
	s, _, _, now := diagnosticStoreFixture(t)
	queued := diagnosticStoreRequest(t, s, "late-result", "one", now)
	job, e := s.ClaimDiagnostic(queued.Scope, "attempt", now)
	if e != nil {
		t.Fatal(e)
	}
	if j, e := s.DiagnosticJob(job.ID, now.Add(18*time.Second)); e != nil || j.Status != "unknown" {
		t.Fatal("missing report did not become unknown")
	}
	rate := 4096.0
	report := diagnostics.Report{JobID: job.ID, Scope: job.Scope, AttemptID: job.AttemptID, Result: diagnostics.Result{Status: "succeeded", Phase: "complete", Code: "completed", StartedAt: now, FinishedAt: now.Add(time.Second), DurationMS: 1000, BytesReceived: 4096, CostKnown: true, HTTPStatus: 200, BytesPerSecond: &rate}}
	if e = s.AcceptDiagnosticReport(report, now.Add(20*time.Second)); e != nil {
		t.Fatalf("durable result could not refine missing outcome: %v", e)
	}
	got, e := s.DiagnosticJob(job.ID, now.Add(21*time.Second))
	if e != nil || got.Status != "succeeded" {
		t.Fatalf("late evidence %+v %v", got, e)
	}
}
