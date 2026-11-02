package entrypolicy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func generatedCapacityBindings(n int) []Binding {
	out := make([]Binding, n)
	for i := range out {
		out[i] = Binding{SubjectID: fmt.Sprintf("sub_%043d", i), AccountID: "u_" + strings.Repeat("a", 43), RouteID: "public-route_" + strings.Repeat("b", 16), EntryID: "entry001", InboundTag: "entry001", CredentialVersion: "credential_" + strings.Repeat("c", 16), PolicyRevision: "topology_" + strings.Repeat("d", 16), CycleID: "cycle_" + strings.Repeat("e", 32)}
	}
	return out
}
func TestTerminalCapacityPreflightIncludesFutureGrowth(t *testing.T) {
	bindings := generatedCapacityBindings(940)
	epoch := strings.Repeat("f", 32)
	baseline := Snapshot{LedgerMode: "admission-budget", ObservedAt: time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), AdapterID: TerminalManagedAdapter, RuntimeVersion: TerminalManagedRuntime, CounterEpoch: epoch, Counters: make([]Counter, len(bindings))}
	for i, b := range bindings {
		baseline.Counters[i] = Counter{CounterEpoch: fmt.Sprintf("%s-%016x", epoch, i), Binding: b, MeasurementLayer: MeasurementLayer}
	}
	proof := TerminalEvidence{Version: 1, NodeID: "node", InstanceID: "instance", EnrollmentEpoch: "enrollment", RuntimeEpoch: epoch, Baseline: baseline, Final: baseline, Digest: strings.Repeat("a", 64)}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw)+TerminalEnvelopeReserveBytes >= terminalEnvelopeLimitBytes {
		t.Fatal("fixture must fit at zero but exceed once counters grow")
	}
	if err = ValidateTerminalCapacity(bindings); err == nil || !strings.Contains(err.Error(), "MANAGED_TERMINAL_CAPACITY_EXCEEDED") {
		t.Fatal("initial zero size admitted unbounded future final", err)
	}
	if err = ValidateTerminalCapacity(generatedCapacityBindings(1)); err != nil {
		t.Fatal("ordinary small profile rejected", err)
	}
}
func TestTerminalCapacityCountAndMetadataAllocationBounds(t *testing.T) {
	for _, bindings := range [][]Binding{nil, make([]Binding, 1001)} {
		if ValidateTerminalCapacity(bindings) == nil {
			t.Fatal("invalid count accepted")
		}
	}
	bindings := generatedCapacityBindings(1)
	bindings[0].SubjectID = strings.Repeat("s", 129)
	if ValidateTerminalCapacity(bindings) == nil {
		t.Fatal("native identity bound not enforced")
	}
}
