package agent

import (
	"encoding/hex"
	"errors"
	"routeweaver/internal/entrypolicy"
)

func validateTerminalBatch(b MeterBatch) error {
	e := b.TerminalEvidence
	if e == nil {
		return nil
	}
	if err := e.Validate(); err != nil {
		return err
	}
	if e.NodeID != b.Scope.NodeID || e.InstanceID != b.Scope.InstanceID || e.EnrollmentEpoch != b.Scope.EnrollmentEpoch || len(b.Samples) != 0 {
		return errors.New("terminal evidence scope or sample mismatch")
	}
	return nil
}
func validateCustodyReceipt(b MeterBatch, r MeterReceipt) error {
	if b.TerminalEvidence == nil {
		if r.CustodyVersion != 0 || r.TerminalEvidenceDigest != "" {
			return errors.New("unexpected terminal custody acknowledgement")
		}
		return nil
	}
	if r.CustodyVersion != entrypolicy.TerminalCustodyVersion || r.TerminalEvidenceDigest != b.TerminalEvidence.Digest {
		return errors.New("explicit matching terminal custody acknowledgement required")
	}
	return nil
}

// ensureTerminalCustodyLocked never treats ACKed live counters as closed-runtime
// custody. The proof is sent once even when its samples have zero byte delta.
func (s *MeterSpool) ensureTerminalCustodyLocked(base, final entrypolicy.Snapshot) (terminalCustody, bool, error) {
	e := entrypolicy.TerminalEvidence{Version: entrypolicy.TerminalCustodyVersion, NodeID: s.disk.Scope.NodeID, InstanceID: s.disk.Scope.InstanceID, EnrollmentEpoch: s.disk.Scope.EnrollmentEpoch, RuntimeEpoch: final.CounterEpoch, Baseline: base, Final: final}
	e.Digest = e.ComputeDigest()
	if err := e.Validate(); err != nil {
		return terminalCustody{}, false, err
	}
	if c, ok := s.disk.TerminalCustody[e.RuntimeEpoch]; ok {
		if c.EvidenceDigest != e.Digest || c.Receipt.TerminalEvidenceDigest != e.Digest || c.Receipt.CustodyVersion != entrypolicy.TerminalCustodyVersion {
			return c, false, errors.New("terminal custody evidence changed")
		}
		return c, true, nil
	}
	for _, b := range s.disk.Pending {
		if b.TerminalEvidence != nil && b.TerminalEvidence.RuntimeEpoch == e.RuntimeEpoch {
			if b.TerminalEvidence.Digest != e.Digest {
				return terminalCustody{}, false, errors.New("pending terminal evidence changed")
			}
			return terminalCustody{}, false, nil
		}
	}
	_, err := s.enqueueEvidenceLocked([]MeterSample{}, nil, &e)
	return terminalCustody{}, false, err
}

func validTerminalDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
