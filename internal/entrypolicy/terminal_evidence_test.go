package entrypolicy

import (
	"strings"
	"testing"
	"time"
)

func terminalFixture() TerminalEvidence {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	c := Counter{CounterEpoch: "epoch-source", Binding: Binding{SubjectID: "s", AccountID: "a", RouteID: "r", EntryID: "e", InboundTag: "in", CredentialVersion: "v1", PolicyRevision: "p", CycleID: "c"}, MeasurementLayer: MeasurementLayer}
	base := Snapshot{AdapterID: TerminalManagedAdapter, RuntimeVersion: TerminalManagedRuntime, LedgerMode: "admission-budget", CounterEpoch: "epoch", ObservedAt: now, Counters: []Counter{c}}
	final := base
	final.Counters = append([]Counter(nil), base.Counters...)
	final.ObservedAt = now.Add(time.Second)
	final.Counters[0].UploadBytes = 37
	final.Counters[0].CumulativeBytes = 37
	e := TerminalEvidence{Version: 1, NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment", RuntimeEpoch: "epoch", Baseline: base, Final: final}
	e.Digest = e.ComputeDigest()
	return e
}
func TestTerminalEvidenceRejectsUnclosedUnboundOrChangedFacts(t *testing.T) {
	if err := terminalFixture().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*TerminalEvidence){
		"version":         func(e *TerminalEvidence) { e.Version = 2 },
		"scope":           func(e *TerminalEvidence) { e.NodeID = "" },
		"active":          func(e *TerminalEvidence) { e.Final.ActiveFlows = 1 },
		"baseline-active": func(e *TerminalEvidence) { e.Baseline.ActiveFlows = 1 },
		"invented-zero": func(e *TerminalEvidence) {
			e.Baseline.Counters[0].UploadBytes = 1
			e.Baseline.Counters[0].CumulativeBytes = 1
		},
		"prefix":  func(e *TerminalEvidence) { e.Final.Counters[0].CounterEpoch = "another-source" },
		"binding": func(e *TerminalEvidence) { e.Final.Counters[0].AccountID = "other" },
		"overflow": func(e *TerminalEvidence) {
			e.Final.Counters[0].UploadBytes = ^uint64(0)
			e.Final.Counters[0].DownloadBytes = 38
		},
		"duplicate": func(e *TerminalEvidence) {
			e.Baseline.Counters = append(e.Baseline.Counters, e.Baseline.Counters[0])
			e.Final.Counters = append(e.Final.Counters, e.Final.Counters[0])
		},
		"time":        func(e *TerminalEvidence) { e.Final.ObservedAt = e.Baseline.ObservedAt.Add(-time.Second) },
		"adapter":     func(e *TerminalEvidence) { e.Final.AdapterID = "unknown" },
		"runtime":     func(e *TerminalEvidence) { e.Final.RuntimeVersion = "unknown" },
		"overlong-id": func(e *TerminalEvidence) { e.Final.Counters[0].SubjectID = strings.Repeat("x", 257) },
	} {
		t.Run(name, func(t *testing.T) {
			e := terminalFixture()
			mutate(&e)
			e.Digest = e.ComputeDigest()
			if e.Validate() == nil {
				t.Fatal("invalid terminal evidence accepted")
			}
		})
	}
	e := terminalFixture()
	e.Final.Counters[0].UploadBytes = 38
	e.Final.Counters[0].CumulativeBytes = 38
	if e.Validate() == nil {
		t.Fatal("changed facts reused prior digest")
	}
}
