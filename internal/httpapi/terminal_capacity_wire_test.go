package httpapi_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
)

// This binds the documented 4096-byte allowance to the real batch and exact-GET
// response shapes. It catches future wrapper growth/escaping changes without
// introducing another wire representation into production.
func TestTerminalCapacityWireReserveCoversRealEnvelopes(t *testing.T) {
	escaped := strings.Repeat("<", 128)
	proof := entrypolicy.TerminalEvidence{Version: 1, NodeID: escaped, InstanceID: escaped, EnrollmentEpoch: escaped, RuntimeEpoch: strings.Repeat("a", 2*entrypolicy.ManagedRuntimeEpochBytes), Digest: strings.Repeat("a", 64)}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	batch := controlprotocol.MeterBatch{TerminalEvidence: &proof, Scope: controlprotocol.Scope{NodeID: escaped, InstanceID: escaped, EnrollmentEpoch: escaped}, StreamEpoch: escaped, Sequence: math.MaxUint64, Digest: strings.Repeat("a", 64), Samples: []controlprotocol.MeterSample{}}
	response := store.TerminalMeterEvidence{ReceiptID: escaped + ":" + escaped + ":" + escaped + ":18446744073709551615", StreamEpoch: escaped, Sequence: math.MaxUint64, BatchDigest: strings.Repeat("a", 64), CustodyVersion: 1, TerminalEvidence: &proof}
	for _, envelope := range []any{batch, response} {
		encoded, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if extra := len(encoded) + 1 - len(raw); extra > entrypolicy.TerminalEnvelopeReserveBytes {
			t.Fatalf("terminal capacity reserve no longer covers actual envelope: extra=%d", extra)
		}
	}
	timestamp := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.FixedZone("capacity", 23*3600+59*60))
	encoded, err := timestamp.MarshalJSON()
	if err != nil || len(encoded)-2 != 35 {
		t.Fatalf("timestamp upper bound changed: %q %v", encoded, err)
	}
}
