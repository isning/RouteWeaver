package entrypolicy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

const TerminalCustodyVersion = 1
const TerminalManagedAdapter = "routeweaver/managed-xray"
const TerminalManagedRuntime = "26.3.27-rw1"

// TerminalEvidence transfers custody of measured closed-runtime facts, never
// authority to settle a per-flow admission budget. Digest covers canonical JSON
// with Digest empty; it is distinct from fingerprints of the original files.
type TerminalEvidence struct {
	Version         int      `json:"version"`
	NodeID          string   `json:"nodeId"`
	InstanceID      string   `json:"instanceId"`
	EnrollmentEpoch string   `json:"enrollmentEpoch"`
	RuntimeEpoch    string   `json:"runtimeEpoch"`
	Baseline        Snapshot `json:"baseline"`
	Final           Snapshot `json:"final"`
	Digest          string   `json:"digest"`
}

var terminalEpoch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (e TerminalEvidence) ComputeDigest() string {
	e.Digest = ""
	raw, _ := json.Marshal(e)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (e TerminalEvidence) Validate() error {
	bad := errors.New("invalid bounded managed terminal evidence")
	if e.Version != TerminalCustodyVersion || !terminalEpoch.MatchString(e.RuntimeEpoch) || e.Digest != e.ComputeDigest() {
		return bad
	}
	for _, id := range []string{e.NodeID, e.InstanceID, e.EnrollmentEpoch} {
		if id == "" || len(id) > 128 || strings.ContainsAny(id, "\x00\r\n") {
			return bad
		}
	}
	if e.Final.ObservedAt.Before(e.Baseline.ObservedAt) || len(e.Baseline.Counters) != len(e.Final.Counters) {
		return bad
	}
	bases := map[string]Counter{}
	for index, s := range []Snapshot{e.Baseline, e.Final} {
		if s.AdapterID != TerminalManagedAdapter || s.RuntimeVersion != TerminalManagedRuntime || s.LedgerMode != "admission-budget" || s.CounterEpoch != e.RuntimeEpoch || s.ActiveFlows != 0 || s.ObservedAt.IsZero() || len(s.Counters) == 0 || len(s.Counters) > 1000 {
			return bad
		}
		seen := map[string]bool{}
		for _, c := range s.Counters {
			if !terminalEpoch.MatchString(c.CounterEpoch) || !strings.HasPrefix(c.CounterEpoch, e.RuntimeEpoch+"-") || c.MeasurementLayer != MeasurementLayer || c.CumulativeBytes < c.UploadBytes || c.CumulativeBytes-c.UploadBytes != c.DownloadBytes {
				return bad
			}
			for _, id := range []string{c.SubjectID, c.AccountID, c.RouteID, c.EntryID, c.InboundTag, c.CredentialVersion, c.PolicyRevision, c.CycleID} {
				if id == "" || len(id) > 256 || strings.ContainsAny(id, "\x00\r\n") {
					return bad
				}
			}
			key := c.CounterEpoch + "\x00" + c.SubjectID + "\x00" + c.RouteID + "\x00" + c.MeasurementLayer
			if seen[key] {
				return bad
			}
			seen[key] = true
			if index == 0 {
				if c.CumulativeBytes != 0 {
					return bad
				}
				bases[key] = c
			} else {
				base, ok := bases[key]
				if !ok || base.Binding != c.Binding {
					return bad
				}
			}
		}
	}
	raw, err := json.Marshal(e)
	if err != nil || len(raw) > 1<<20 {
		return bad
	}
	return nil
}
func (e TerminalEvidence) Clone() *TerminalEvidence {
	e.Baseline.Counters = append([]Counter(nil), e.Baseline.Counters...)
	e.Final.Counters = append([]Counter(nil), e.Final.Counters...)
	return &e
}
