package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestDriverReportsRemainOrderedAcrossRestart(t *testing.T) {
	root := t.TempDir()
	r := openTest(t, root, LocalFixture{})
	d := testDesired(t, 1)
	tr := &driverTransport{desired: &d}
	run := func(r *Reconciler) State {
		t.Helper()
		final, err := RunDriver(context.Background(), r, tr, nil, DriverOptions{PollInterval: 10 * time.Millisecond, LeaseInterval: 5 * time.Millisecond, MaxRuntime: 70 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		return final
	}
	first := run(r)
	if first.ReportSequence == 0 {
		t.Fatal("driver reports have no durable ordering fence")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	r = openTest(t, root, LocalFixture{})
	second := run(r)
	if second.ReportSequence <= first.ReportSequence {
		t.Fatalf("report sequence reset across restart: %d -> %d", first.ReportSequence, second.ReportSequence)
	}
	var previous uint64
	for _, report := range tr.reports {
		if report.ReportSequence <= previous {
			t.Fatalf("unordered report: %d after %d", report.ReportSequence, previous)
		}
		previous = report.ReportSequence
	}
	if tr.reports[len(tr.reports)-1].Phase != "stopped" {
		t.Fatal("final stopped report absent")
	}
}

func TestObservationReportRequiresDurableSequence(t *testing.T) {
	root := t.TempDir()
	r := openTest(t, root, LocalFixture{})
	if _, err := r.Submit(context.Background(), testDesired(t, 1)); err != nil {
		t.Fatal(err)
	}
	first, err := r.ObservationReport()
	if err != nil || first.ReportSequence == 0 {
		t.Fatalf("first report: %+v %v", first, err)
	}
	path := filepath.Join(root, "state.json")
	if err := os.Rename(path, path+".retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if report, err := r.ObservationReport(); err == nil || report.ReportSequence != 0 {
		t.Fatalf("failed journal produced a sendable report: %+v %v", report, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	next, err := r.ObservationReport()
	if err != nil || next.ReportSequence <= first.ReportSequence {
		t.Fatalf("recovered report: %+v %v", next, err)
	}
	if next.Phase != Unknown || !next.RecoveryRequired {
		t.Fatalf("journal failure was hidden: %+v", next)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if report, err := r.ObservationReport(); err == nil || report.ReportSequence != 0 {
		t.Fatalf("closed reconciler produced report: %+v %v", report, err)
	}
}

func TestObservationSequenceDoesNotChangeRuntimeFactsOrWrap(t *testing.T) {
	root := t.TempDir()
	r := openTest(t, root, LocalFixture{})
	d := testDesired(t, 1)
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	before := r.State()
	first, err := r.ObservationReport()
	if err != nil {
		t.Fatal(err)
	}
	first.ReportSequence = 0
	if !reflect.DeepEqual(before, first) || !reflect.DeepEqual(before, r.State()) {
		t.Fatal("report allocation changed runtime facts")
	}
	d.Generation = 2
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	second, err := r.ObservationReport()
	if err != nil || second.ReportSequence != 2 || second.HighestAccepted != 2 {
		t.Fatalf("new generation reset sequence: %+v %v", second, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "state.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var journal map[string]json.RawMessage
	if err := json.Unmarshal(raw, &journal); err != nil {
		t.Fatal(err)
	}
	journal["reportSequence"] = json.RawMessage(`"18446744073709551615"`)
	raw, err = json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	r = openTest(t, root, LocalFixture{})
	if report, err := r.ObservationReport(); err == nil || report.ReportSequence != 0 {
		t.Fatalf("exhausted sequence wrapped: %+v %v", report, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(after, raw) {
		t.Fatal("exhausted sequence changed the journal", err)
	}
}
