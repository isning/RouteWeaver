// Package entrypolicy contains the credential-free wire contract between a
// managed entry runtime and an authoritative admission service. It deliberately
// imports no HTTP, storage, agent or proxy-core implementation.
package entrypolicy

import (
	"context"
	"time"
)

const (
	SchemaVersion    = 1
	MaxLease         = 30 * time.Second
	RenewInterval    = 10 * time.Second
	MeasurementLayer = "managed-entry-admitted-payload"
)

type AdmissionRequest struct {
	AdmittedBytes     uint64 `json:"admittedBytes,string"`
	Final             bool   `json:"final"`
	EntryID           string `json:"entryId"`
	SubjectID         string `json:"subjectId"`
	CredentialVersion string `json:"credentialVersion"`
	ClientIP          string `json:"clientIp"`
	PresenceID        string `json:"presenceId"`
}

// Lease is an authoritative decision, not a process-local IP count. Renew by
// acquiring with the same PresenceID. A successful grant must include a stable
// lease ID, verified account/route attribution and a bounded expiry.
type Lease struct {
	ByteBudget   *uint64   `json:"byteBudget,string,omitempty"`
	Allowed      bool      `json:"allowed"`
	LeaseID      string    `json:"leaseId"`
	AccountID    string    `json:"accountId,omitempty"`
	RouteID      string    `json:"routeId,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt"`
	Reason       string    `json:"reason,omitempty"`
	EntryRateBPS int64     `json:"entryRateBps"`
}

type Admission interface {
	Acquire(context.Context, AdmissionRequest) (Lease, error)
	Release(context.Context, string) error
}

// Binding is private administrator-controlled sidecar data. SubjectID is an
// opaque native authenticated identity, not a caller-supplied account name.
type Binding struct {
	SubjectID         string `json:"subjectId"`
	AccountID         string `json:"accountId"`
	RouteID           string `json:"routeId"`
	EntryID           string `json:"entryId"`
	InboundTag        string `json:"inboundTag"`
	CredentialVersion string `json:"credentialVersion"`
	PolicyRevision    string `json:"policyRevision"`
	CycleID           string `json:"cycleId"`
}

type DestinationPolicy struct {
	AllowCIDRs []string `json:"allowCidrs,omitempty"`
}
type Descriptor struct {
	DestinationPolicy DestinationPolicy `json:"destinationPolicy"`
	SchemaVersion     int               `json:"schemaVersion"`
	AdapterID         string            `json:"adapterId"`
	RuntimeVersion    string            `json:"runtimeVersion"`
	CoreVersion       string            `json:"coreVersion"`
	Bindings          []Binding         `json:"bindings"`
}

type Counter struct {
	CounterEpoch string `json:"counterEpoch"`
	Binding
	MeasurementLayer string `json:"measurementLayer"`
	UploadBytes      uint64 `json:"uploadBytes,string"`
	DownloadBytes    uint64 `json:"downloadBytes,string"`
	CumulativeBytes  uint64 `json:"cumulativeBytes,string"`
}

type Snapshot struct {
	LedgerMode     string    `json:"ledgerMode"`
	ObservedAt     time.Time `json:"observedAt"`
	AdapterID      string    `json:"adapterId"`
	RuntimeVersion string    `json:"runtimeVersion"`
	CounterEpoch   string    `json:"counterEpoch"`
	ActiveFlows    int       `json:"activeFlows"`
	RejectedFlows  uint64    `json:"rejectedFlows,string"`
	Counters       []Counter `json:"counters"`
}
