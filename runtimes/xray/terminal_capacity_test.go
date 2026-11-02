package managedxray

import (
	"fmt"
	"strings"
	"testing"

	"routeweaver/internal/entrypolicy"
)

// build validates the managed descriptor before constructing any upstream core.
// No proxy, listener or executable is started by this regression.
func TestTerminalCapacityBuildRejectsBeforeNativeParsing(t *testing.T) {
	d := entrypolicy.Descriptor{SchemaVersion: entrypolicy.SchemaVersion, AdapterID: AdapterID, RuntimeVersion: Version, CoreVersion: CoreVersion, Bindings: make([]entrypolicy.Binding, 1000)}
	for i := range d.Bindings {
		d.Bindings[i] = entrypolicy.Binding{SubjectID: fmt.Sprintf("sub_%043d", i), AccountID: "u_" + strings.Repeat("a", 43), RouteID: "public-route_" + strings.Repeat("b", 16), EntryID: "entry001", InboundTag: "entry001", CredentialVersion: "credential_" + strings.Repeat("c", 16), PolicyRevision: "topology_" + strings.Repeat("d", 16), CycleID: "cycle_" + strings.Repeat("e", 32)}
	}
	_, err := build([]byte(`{}`), d)
	if err == nil || !strings.Contains(err.Error(), "MANAGED_TERMINAL_CAPACITY_EXCEEDED") {
		t.Fatalf("runtime descriptor capacity must reject before upstream configuration construction: %v", err)
	}
}
