// Package controlprotocol defines pure control-plane/agent wire
// values and deterministic integrity checks. It imports no HTTP, OS, runtime,
// renderer or storage implementation and does not authenticate supplied data.
package controlprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"sort"
	"strings"
	"time"
)

const (
	Accepted           = "accepted"
	NativeValidated    = "native_validated"
	Applying           = "applying"
	AppliedUnobserved  = "applied_unobserved"
	ObservedConformant = "observed_conformant"
	ValidationFailed   = "validation_failed"
	ApplyFailed        = "apply_failed"
	Unknown            = "unknown"
	Blocked            = "blocked"
)

type Scope = domain.InstanceScope

// PolicyLease has no product default lifetime. The local harness requires an
// explicit maximum. Production clock/freshness and enforcement remain gates.
type PolicyLease struct {
	Revision      string    `json:"revision"`
	IssuedAt      time.Time `json:"issuedAt"`
	ExpiresAt     time.Time `json:"expiresAt"`
	AccessAllowed bool      `json:"accessAllowed"`
	QuotaCertain  bool      `json:"quotaCertain"`
}

// CoreTransition explicitly binds a reviewed replacement to the previous runtime
// identity. Rollback uses a new generation and current policy, never old leases.
type CoreTransition struct {
	From             Identity `json:"from"`
	ReleaseID        string   `json:"releaseId,omitempty"`
	ExecutableSHA256 string   `json:"executableSHA256,omitempty"`
}
type CoreInstallation struct {
	ReleaseID        string `json:"releaseId"`
	AdapterID        string `json:"adapterId"`
	Version          string `json:"version"`
	Platform         string `json:"platform"`
	ExecutableSHA256 string `json:"executableSHA256"`
}

type Desired struct {
	Scope
	Action        string            `json:"action,omitempty"`
	CoreReleaseID string            `json:"coreReleaseId,omitempty"`
	Transition    *CoreTransition   `json:"transition,omitempty"`
	AdapterID     string            `json:"adapterId"`
	CoreVersion   string            `json:"coreVersion"`
	Generation    uint64            `json:"generation,string"`
	RevisionID    string            `json:"revisionId"`
	OperationID   string            `json:"operationId"`
	Digest        string            `json:"digest"`
	EntryFile     string            `json:"entryFile"`
	Artifacts     []domain.Artifact `json:"artifacts"`
	Lease         PolicyLease       `json:"policyLease"`
}

// Identity is safe to report without the private materialized artifact bytes.
type Identity struct {
	Scope
	AdapterID   string `json:"adapterId"`
	CoreVersion string `json:"coreVersion"`
	Generation  uint64 `json:"generation,string"`
	RevisionID  string `json:"revisionId"`
	OperationID string `json:"operationId"`
	Digest      string `json:"digest"`
}

func (d Desired) Identity() Identity {
	return Identity{d.Scope, d.AdapterID, d.CoreVersion, d.Generation, d.RevisionID, d.OperationID, d.Digest}
}

type Observation struct {
	Identity
	Known      bool      `json:"known"`
	Quiescent  bool      `json:"quiescent"`
	Evidence   string    `json:"evidence"`
	ObservedAt time.Time `json:"observedAt"`
}

type State struct {
	Installation     *CoreInstallation `json:"installation,omitempty"`
	HighestAccepted  uint64            `json:"highestAccepted,string"`
	Desired          *Identity         `json:"desired,omitempty"`
	Observed         *Observation      `json:"observed,omitempty"`
	LastKnownValid   *Identity         `json:"lastKnownValid,omitempty"`
	Phase            string            `json:"phase"`
	Code             string            `json:"code,omitempty"`
	NativeChecked    bool              `json:"nativeChecked"`
	RecoveryRequired bool              `json:"recoveryRequired"`
	// AccessDecision is a gate result, NOT evidence that existing sessions ended.
	AccessDecision string `json:"accessDecision,omitempty"`
}

// MeterSample reports a cumulative source measurement, not a quota debit.
// Attribution, counter epoch and policy/cycle identity must come from verified
// meter bindings. No global online-IP admission or weighted accounting is
// inferred by this spool, and provider bytes must use a separate stream.
type MeterSample struct {
	LedgerMode       string    `json:"ledgerMode,omitempty"`
	SampleID         string    `json:"sampleId"`
	CounterEpoch     string    `json:"counterEpoch"`
	SubjectID        string    `json:"subjectId"`
	RouteID          string    `json:"routeId"`
	PolicyRevision   string    `json:"policyRevision"`
	CycleID          string    `json:"cycleId"`
	MeasurementLayer string    `json:"measurementLayer"`
	CumulativeBytes  uint64    `json:"cumulativeBytes,string"`
	ObservedAt       time.Time `json:"observedAt"`
}

// MeterBatch carries either ordinary samples or a terminal-only custody proof.
// A terminal proof has no samples and cannot debit or settle a budget.
type MeterBatch struct {
	TerminalEvidence *entrypolicy.TerminalEvidence `json:"terminalEvidence,omitempty"`
	Scope            Scope                         `json:"scope"`
	StreamEpoch      string                        `json:"streamEpoch"`
	Sequence         uint64                        `json:"sequence,string"`
	Digest           string                        `json:"digest"`
	Samples          []MeterSample                 `json:"samples"`
}

// Terminal custody requires both explicit version and exact evidence digest;
// an ordinary receipt never acquires terminal semantics from equal byte counts.
type MeterReceipt struct {
	CustodyVersion         int    `json:"custodyVersion,omitempty"`
	TerminalEvidenceDigest string `json:"terminalEvidenceDigest,omitempty"`
	StreamEpoch            string `json:"streamEpoch"`
	Sequence               uint64 `json:"sequence,string"`
	Digest                 string `json:"digest"`
}

func validArtifactPath(p string) bool {
	return p != "" && p != "." && path.Clean(p) == p && !path.IsAbs(p) && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsAny(p, "\\\x00\r\n") && len(p) <= 240
}

// ArtifactDigest is a deterministic SHA256 over sorted paths and exact content.
// It is separate from any intent or renderer digest.
func ArtifactDigest(artifacts []domain.Artifact) (string, error) {
	if len(artifacts) == 0 || len(artifacts) > 64 {
		return "", errors.New("artifact count out of bounds")
	}
	sorted := append([]domain.Artifact(nil), artifacts...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	size := 0
	for i, a := range sorted {
		size += len(a.Content)
		if !validArtifactPath(a.Path) || size > 8<<20 {
			return "", errors.New("invalid artifact path or size")
		}
		if i > 0 && sorted[i-1].Path == a.Path {
			return "", errors.New("duplicate artifact path")
		}
	}
	b, err := json.Marshal(sorted)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// ValidateDesired validates incoming intent, including the current install policy.
func ValidateDesired(d Desired, scope Scope) error {
	if d.Action == "install" || d.Action == "upgrade" {
		if _, err := FindInstallableCoreRelease(d.CoreReleaseID); err != nil {
			return err
		}
	}
	return ValidateRetainedDesired(d, scope)
}

// ValidateRetainedDesired checks immutable identity and artifact integrity for a
// previously accepted private journal. It does not authorize new intent or
// re-install retired releases. Incoming transport and Submit use ValidateDesired.
func ValidateRetainedDesired(d Desired, scope Scope) error {
	if err := validateCoreLifecycle(d, scope); err != nil {
		return err
	}
	if d.Scope != scope {
		return errors.New("node, instance or enrollment scope mismatch")
	}
	if d.Generation == 0 || !domain.ValidID(d.RevisionID) || !domain.ValidID(d.OperationID) {
		return errors.New("invalid deployment identity")
	}
	if !validArtifactPath(d.EntryFile) {
		return errors.New("invalid entry file")
	}
	found := false
	for _, a := range d.Artifacts {
		found = found || a.Path == d.EntryFile
	}
	if !found {
		return errors.New("entry file missing from artifacts")
	}
	encoded, err := json.Marshal(d)
	if err != nil || len(encoded) > 10<<20 {
		return errors.New("desired envelope too large")
	}
	digest, err := ArtifactDigest(d.Artifacts)
	if err != nil {
		return err
	}
	if digest != d.Digest {
		return errors.New("artifact digest mismatch")
	}
	return nil
}
func RequestDigest(d Desired) string {
	b, _ := json.Marshal(d)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// MeterBatchDigest hashes the unsigned batch envelope (Digest is excluded).
func MeterBatchDigest(batch MeterBatch) (string, error) {
	batch.Digest = ""
	raw, err := json.Marshal(batch)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
