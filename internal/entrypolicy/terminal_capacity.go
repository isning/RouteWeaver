package entrypolicy

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// Shared with the managed producer: changing epoch encoding must also change
// this capacity contract before a new runtime can be admitted.
const ManagedRuntimeEpochBytes = 16
const ManagedCounterSuffixBytes = 8

const terminalEnvelopeLimitBytes = 1 << 20

// The proof below already includes its own maximally escaped scope strings.
// Outside the proof, a meter batch needs <=3*128*6 scope bytes +128*6 stream
// bytes +20 sequence digits +64 digest bytes +JSON field names/punctuation.
// Exact GET repeats stream/sequence inside receiptId and separate fields:
// <=(3*128+128)*6 +2*20 +64 +field names/punctuation. Both are <4096,
// including the response newline. Wire-shape tests check this explicit reserve.
const TerminalEnvelopeReserveBytes = 4096

// ValidateTerminalCapacity is a pre-activation check, not a different protocol
// limit. Count and byte ceilings both apply. It uses actual binding metadata,
// but reserves future counter growth and the largest legal wire identities and
// timestamps so a zero-byte start cannot admit an undeliverable final.
func ValidateTerminalCapacity(bindings []Binding) error {
	if len(bindings) == 0 || len(bindings) > 1000 {
		return fmt.Errorf("invalid managed binding count")
	}
	epoch := strings.Repeat("f", 2*ManagedRuntimeEpochBytes)
	// RFC3339Nano with a non-UTC offset is 35 bytes, conservatively covering UTC.
	at := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.FixedZone("capacity", 23*3600+59*60))
	baseline := Snapshot{LedgerMode: "admission-budget", ObservedAt: at, AdapterID: TerminalManagedAdapter, RuntimeVersion: TerminalManagedRuntime, CounterEpoch: epoch, RejectedFlows: math.MaxUint64, Counters: make([]Counter, len(bindings))}
	final := baseline
	final.Counters = make([]Counter, len(bindings))
	final.RejectedFlows = math.MaxUint64
	for i, b := range bindings {
		// The native descriptor already limits identities to <=128 ASCII bytes.
		// Bound allocation here as well; existing semantic validators remain owners
		// of identity syntax and duplicates.
		for _, id := range []string{b.SubjectID, b.AccountID, b.RouteID, b.EntryID, b.InboundTag, b.CredentialVersion, b.PolicyRevision, b.CycleID} {
			if len(id) > 128 {
				return fmt.Errorf("managed binding identity exceeds native bound")
			}
		}
		c := Counter{CounterEpoch: fmt.Sprintf("%s-%0*x", epoch, 2*ManagedCounterSuffixBytes, i), Binding: b, MeasurementLayer: MeasurementLayer}
		baseline.Counters[i] = c
		// Largest valid decimal-width sum: 20 upload +19 download +20 total digits.
		// Two 20-digit directions cannot sum to a uint64 without overflow.
		c.UploadBytes = 10000000000000000000
		c.DownloadBytes = math.MaxUint64 - c.UploadBytes
		c.CumulativeBytes = math.MaxUint64
		final.Counters[i] = c
	}
	scope := strings.Repeat("<", 128) // encoding/json escapes '<' to six ASCII bytes.
	proof := TerminalEvidence{Version: TerminalCustodyVersion, NodeID: scope, InstanceID: scope, EnrollmentEpoch: scope, RuntimeEpoch: epoch, Baseline: baseline, Final: final, Digest: strings.Repeat("a", 64)}
	raw, err := json.Marshal(proof)
	if err != nil {
		return fmt.Errorf("cannot estimate managed terminal capacity: %w", err)
	}
	upper := len(raw) + TerminalEnvelopeReserveBytes
	if upper > terminalEnvelopeLimitBytes {
		return fmt.Errorf("MANAGED_TERMINAL_CAPACITY_EXCEEDED: terminal evidence upper bound %d bytes exceeds %d; reduce principal count or binding metadata before activation", upper, terminalEnvelopeLimitBytes)
	}
	return nil
}
