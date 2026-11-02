package store_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
)

// Regression initially RED at ac7ad58: a stopped epoch's reviewed final measurement must survive until
// operator recovery can use it. No native process or concurrent stop is involved.
// ACKed live bytes are not proof that a runtime has reached its final state.
func TestManagedFinalEvidenceSurvivesACKedLiveCompactionWithUnresolvedBudget(t *testing.T) {
	s, dbPath, key, admissionScope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	request := admissionRequest("entry1", "192.0.2.1", "only-flow")
	lease, err := s.AcquireAdmission(admissionScope, request, now)
	if err != nil || !lease.Allowed {
		t.Fatalf("admission: %v", err)
	}
	request.AdmittedBytes = 37
	if decision, err := s.AcquireAdmission(admissionScope, request, now.Add(time.Second)); err != nil || !decision.Allowed {
		t.Fatalf("live settlement: %v", err)
	}
	binding := store.MeterBinding{ID: "meter", InstanceID: admissionScope.InstanceID, SubjectID: "subject", UserID: "account", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	spoolPath := filepath.Join(root, "spool")
	scope := agent.Scope{NodeID: admissionScope.NodeID, InstanceID: admissionScope.InstanceID, EnrollmentEpoch: admissionScope.EnrollmentEpoch}
	spool, err := agent.OpenMeterSpool(spoolPath, scope, "stream")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { spool.Close() }()
	snapshot := func(at time.Time, value uint64, active int) entrypolicy.Snapshot {
		return entrypolicy.Snapshot{LedgerMode: "admission-budget", ObservedAt: at, AdapterID: agent.ManagedXrayID, RuntimeVersion: agent.ManagedXrayVersion, CounterEpoch: "runtime-one", ActiveFlows: active, Counters: []entrypolicy.Counter{{CounterEpoch: "runtime-one-source", Binding: entrypolicy.Binding{AccountID: "account", EntryID: "entry1", InboundTag: "public", CredentialVersion: "v1", SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle"}, MeasurementLayer: entrypolicy.MeasurementLayer, UploadBytes: value, CumulativeBytes: value}}}
	}
	write := func(kind string, snap entrypolicy.Snapshot) {
		t.Helper()
		dir := agent.ManagedJournalDirectory(root)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(snap)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "runtime-one."+kind+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	deliver := func() {
		t.Helper()
		for _, batch := range spool.Pending() {
			// The public persistence seam receives the same original batch as HTTP ingestion.
			raw, err := json.Marshal(batch.Samples)
			if err != nil {
				t.Fatal(err)
			}
			var samples []store.CounterSample
			if err = json.Unmarshal(raw, &samples); err != nil {
				t.Fatal(err)
			}
			stored := store.CounterBatch{InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest, Samples: samples, TerminalEvidence: batch.TerminalEvidence}
			if err = s.AcceptCounterBatch(stored, batch); err != nil {
				t.Fatal(err)
			}
			receipt := agent.MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest}
			if batch.TerminalEvidence != nil {
				receipt.CustodyVersion = entrypolicy.TerminalCustodyVersion
				receipt.TerminalEvidenceDigest = batch.TerminalEvidence.Digest
			}
			if err = spool.Ack(receipt); err != nil {
				t.Fatal(err)
			}
		}
	}
	baseline := snapshot(now, 0, 0)
	write("baseline", baseline)
	if err = agent.CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	deliver()
	live := snapshot(now.Add(time.Second), 37, 1)
	if err = spool.EnqueueManagedSnapshot(live); err != nil {
		t.Fatal(err)
	}
	deliver()
	before, err := s.List("meter-inbox")
	if err != nil || len(before) != 2 {
		t.Fatalf("baseline/live inbox: %d %v", len(before), err)
	}
	final := snapshot(now.Add(2*time.Second), 37, 0)
	write("final", final) // Models a completed owned stop, after all workers joined.
	if err = agent.CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	pending := spool.Pending()
	if len(pending) != 1 || pending[0].TerminalEvidence == nil {
		t.Fatal("zero-delta final did not enqueue independent custody proof")
	}
	terminalBatch := pending[0]
	// Until CP custody is confirmed the genuine final stays available locally.
	if journals, err := agent.ReadManagedJournal(root); err != nil || len(journals) != 2 {
		t.Fatal("unacknowledged final was deleted", err)
	}
	deliver()
	if err = agent.CollectManagedCounters(context.Background(), root, spool, false); err != nil {
		t.Fatal(err)
	}
	spool.Close()
	spool, err = agent.OpenMeterSpool(spoolPath, scope, "stream")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(dbPath, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reviews, err := reopened.AdmissionBudgetReviews(scope.InstanceID, now.Add(time.Minute))
	if err != nil || len(reviews) != 1 || reviews[0].Closed || !reviews[0].Unresolved || reviews[0].GrantedRaw != 100 || reviews[0].SettledRaw != 37 {
		t.Fatalf("reservation changed: %+v %v", reviews, err)
	}
	after, err := reopened.List("meter-inbox")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 3 {
		t.Fatalf("expected baseline/live/terminal raw inbox, got %d", len(after))
	}
	for _, original := range before {
		found := false
		for _, retained := range after {
			if reflect.DeepEqual(original, retained) {
				found = true
			}
		}
		if !found {
			t.Fatal("canonical live evidence changed")
		}
	}
	evidence, err := reopened.MeterTerminalEvidence(scope.InstanceID, scope.EnrollmentEpoch, terminalBatch.StreamEpoch, terminalBatch.Sequence)
	if err != nil || !reflect.DeepEqual(evidence.TerminalEvidence.Final, final) || evidence.TerminalEvidence.Digest != terminalBatch.TerminalEvidence.Digest {
		t.Fatalf("independent final custody missing after CP reopen: %v", err)
	}
	if usage, err := reopened.Usage("account", time.Time{}, time.Time{}); err != nil || usage.RawBytes != 37 {
		t.Fatalf("settled usage changed: %+v %v", usage, err)
	}
	journals, err := agent.ReadManagedJournal(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(journals) != 0 || len(spool.Pending()) != 0 {
		t.Fatal("ACKed terminal custody did not permit bounded local GC")
	}
}
