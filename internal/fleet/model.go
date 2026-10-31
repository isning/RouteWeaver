// Package fleet owns bounded rollout plans and evidence-based outcomes. It has
// no transport, persistence, process execution, or authority to grant access.
package fleet

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"sort"
	"time"
)

type Input struct {
	Action          string     `json:"action"`
	DeploymentID    string     `json:"deploymentId"`
	TargetIDs       []string   `json:"targetIds"`
	Stages          [][]string `json:"stages,omitempty"`
	SourceBatchID   string     `json:"sourceBatchId,omitempty"`
	TargetReleaseID string     `json:"targetReleaseId,omitempty"`
}
type Plan struct {
	Input
	Fingerprint   string   `json:"fingerprint"`
	Targets       []Target `json:"targets"`
	AffectedUsers int      `json:"affectedUsers"`
	Supported     bool     `json:"supported"`
	Diagnostics   []string `json:"diagnostics"`
	Disruption    string   `json:"disruption"`
}
type ConfigChange struct {
	Path   string `json:"path"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type Target struct {
	ConfigDiff       []ConfigChange `json:"configDiff"`
	CurrentVersion   string         `json:"currentVersion,omitempty"`
	InstanceID       string         `json:"instanceId"`
	NodeID           string         `json:"nodeId"`
	Name             string         `json:"name"`
	AdapterID        string         `json:"adapterId"`
	CoreVersion      string         `json:"coreVersion"`
	Stage            int            `json:"stage"`
	AffectedRouteIDs []string       `json:"affectedRouteIds"`
	AffectedUsers    int            `json:"affectedUsers"`
	Changes          []string       `json:"changes"`
	Supported        bool           `json:"supported"`
	Diagnostics      []string       `json:"diagnostics"`
	Status           string         `json:"status"`
	Attempts         []Attempt      `json:"attempts"`
}
type Attempt struct {
	Detail         string                    `json:"detail,omitempty"`
	CoreReleaseID  string                    `json:"coreReleaseId,omitempty"`
	Number         int                       `json:"number"`
	RequestID      string                    `json:"requestId"`
	Identity       *controlprotocol.Identity `json:"identity,omitempty"`
	Status         string                    `json:"status"`
	Code           string                    `json:"code,omitempty"`
	QueuedAt       time.Time                 `json:"queuedAt"`
	LeaseExpiresAt time.Time                 `json:"leaseExpiresAt"`
	ObservedAt     *time.Time                `json:"observedAt,omitempty"`
}
type Batch struct {
	ID string `json:"id"`
	Plan
	ActorID      string    `json:"actorId"`
	CreatedAt    time.Time `json:"createdAt"`
	LeaseSeconds int       `json:"leaseSeconds"`
	Status       string    `json:"status"`
}

func Stages(in Input) (map[string]int, error) {
	if !domain.ValidID(in.DeploymentID) || len(in.TargetIDs) == 0 || len(in.TargetIDs) > 100 {
		return nil, fmt.Errorf("deployment and 1–100 explicit targets required")
	}
	switch in.Action {
	case "configure", "start", "stop", "rollback", "install", "upgrade":
	default:
		return nil, fmt.Errorf("unsupported fleet action")
	}
	if in.TargetReleaseID != "" && in.Action != "install" && in.Action != "upgrade" {
		return nil, fmt.Errorf("targetReleaseId is only valid for install or upgrade")
	}
	if in.Action == "rollback" && !domain.ValidID(in.SourceBatchID) {
		return nil, fmt.Errorf("rollback requires a reviewed historic batch")
	}
	selected := map[string]bool{}
	for _, id := range in.TargetIDs {
		if !domain.ValidID(id) || selected[id] {
			return nil, fmt.Errorf("target identities must be valid and unique")
		}
		selected[id] = true
	}
	stages := in.Stages
	if len(stages) == 0 {
		stages = [][]string{in.TargetIDs}
	}
	if len(stages) > 20 {
		return nil, fmt.Errorf("at most 20 explicit stages supported")
	}
	out := map[string]int{}
	for stage, ids := range stages {
		if len(ids) == 0 {
			return nil, fmt.Errorf("stages cannot be empty")
		}
		for _, id := range ids {
			if _, ok := out[id]; ok || !selected[id] {
				return nil, fmt.Errorf("every selected target must occur in exactly one stage")
			}
			out[id] = stage
		}
	}
	if len(out) != len(selected) {
		return nil, fmt.Errorf("every selected target must occur in exactly one stage")
	}
	return out, nil
}
func Fingerprint(value any) string {
	b, _ := json.Marshal(value)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func ChangedArtifacts(old, next []domain.Artifact) []string {
	previous := map[string]string{}
	for _, a := range old {
		previous[a.Path] = a.Content
	}
	changes := []string{}
	for _, a := range next {
		content, ok := previous[a.Path]
		if !ok || content != a.Content {
			changes = append(changes, a.Path)
		}
		delete(previous, a.Path)
	}
	for p := range previous {
		changes = append(changes, p)
	}
	sort.Strings(changes)
	return changes
}
func Outcome(action string, a Attempt, state *controlprotocol.State, now time.Time) Attempt {
	if a.Identity == nil {
		return a
	}
	if state == nil || state.Desired == nil || *state.Desired != *a.Identity {
		if state != nil && state.Desired != nil && state.Desired.Generation > a.Identity.Generation {
			a.Status = "superseded"
			a.Code = "desired_superseded_review_required"
			return a
		}
		if !a.LeaseExpiresAt.IsZero() && !now.Before(a.LeaseExpiresAt) {
			a.Status = "unknown"
			a.Code = "lease_expired_without_observation_reconnect_agent"
		}
		return a
	}
	if state.RecoveryRequired {
		a.Status = "unknown"
		a.Code = "runtime_recovery_required"
		return a
	}
	if action == "install" && state.Phase == "installed" && state.Code == "artifact_installed" && state.NativeChecked && state.Installation != nil {
		release, err := controlprotocol.FindCoreRelease(a.CoreReleaseID)
		if err == nil && state.Installation.ReleaseID == release.ID && state.Installation.AdapterID == release.AdapterID && state.Installation.Version == release.Version && state.Installation.Platform == release.Platform && state.Installation.ExecutableSHA256 == release.ExecutableSHA256 {
			a.Status = "succeeded"
			a.Code = "artifact_installed"
			return a
		}
	}
	if action == "stop" && state.Phase == controlprotocol.Blocked && state.Code == "policy_restricted" && state.Observed == nil {
		a.Status = "succeeded"
		a.Code = "owned_runtime_stopped"
		return a
	}
	if action != "stop" && action != "install" && state.Phase == controlprotocol.ObservedConformant && state.NativeChecked && state.Observed != nil && state.Observed.Known && state.Observed.Quiescent && state.Observed.Identity == *a.Identity {
		a.Status = "succeeded"
		a.Code = "observed_conformant"
		at := state.Observed.ObservedAt
		a.ObservedAt = &at
		return a
	}
	if !a.LeaseExpiresAt.IsZero() && !now.Before(a.LeaseExpiresAt) && (state.Phase == controlprotocol.Accepted || state.Phase == controlprotocol.NativeValidated || state.Phase == controlprotocol.Applying || state.Phase == controlprotocol.AppliedUnobserved) {
		a.Status = "unknown"
		a.Code = "lease_expired_without_observation_reconnect_agent"
		return a
	}
	switch state.Phase {
	case controlprotocol.ValidationFailed, controlprotocol.ApplyFailed, controlprotocol.Blocked, "stopped":
		a.Status = "failed"
		a.Code = state.Code
	case controlprotocol.Unknown:
		a.Status = "unknown"
		a.Code = state.Code
	default:
		a.Status = "pending"
		a.Code = state.Phase
	}
	return a
}
func CanExecuteStage(targets []Target, stage int) error {
	found := false
	for _, t := range targets {
		if t.Stage == stage {
			found = true
		}
		if t.Stage < stage && t.Status != "succeeded" {
			return fmt.Errorf("previous stage requires exact successful observations")
		}
	}
	if !found {
		return fmt.Errorf("stage is absent")
	}
	return nil
}
func Status(targets []Target) string {
	succeeded, failed, pending, planned := 0, 0, 0, 0
	for _, t := range targets {
		switch t.Status {
		case "succeeded":
			succeeded++
		case "failed", "unsupported", "superseded":
			failed++
		case "planned":
			planned++
		default:
			pending++
		}
	}
	switch {
	case succeeded == len(targets) && succeeded > 0:
		return "succeeded"
	case pending > 0:
		return "pending"
	case failed > 0 && succeeded > 0:
		return "partial_failure"
	case failed > 0:
		return "failed"
	case planned > 0 && succeeded > 0:
		return "awaiting_stage"
	default:
		return "planned"
	}
}
