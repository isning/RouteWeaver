// Package diagnostics defines bounded operator diagnostic intent and evidence.
// It owns no network, persistence, process execution or automatic route changes.
package diagnostics

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"time"

	"routeweaver/internal/domain"
)

const MaxPayloadBytes int64 = 16 << 20
const UploadResponseBytes int64 = 16 << 10
const MaxTimeoutSeconds = 30

var ErrScope = errors.New("diagnostic scope does not match current enrollment or target")

// ErrNotStarted is only returned before any diagnostic network execution.
var ErrNotStarted = errors.New("managed diagnostic did not start")
var ErrInvalid = errors.New("invalid bounded diagnostic")

type Target struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	NodeID  string   `json:"nodeId"`
	URL     string   `json:"url"`
	Methods []string `json:"methods"`
}

func (t Target) Validate() error {
	if !domain.ValidID(t.ID) || !domain.ValidID(t.NodeID) || t.Name == "" || len(t.Name) > 128 || t.URL == "" || len(t.URL) > 2048 || len(t.Methods) < 1 || len(t.Methods) > 3 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, m := range t.Methods {
		if (m != "connectivity" && m != "download" && m != "upload") || seen[m] {
			return ErrInvalid
		}
		seen[m] = true
	}
	return nil
}

type Request struct {
	PathMode         string `json:"pathMode,omitempty"`
	PublishedRouteID string `json:"publishedRouteId,omitempty"`
	ID               string `json:"id"`
	TargetID         string `json:"targetId"`
	InstanceID       string `json:"instanceId"`
	Kind             string `json:"kind"`
	MaxBytes         int64  `json:"maxBytes"`
	TimeoutSeconds   int    `json:"timeoutSeconds"`
}
type Job struct {
	Request
	ManagedPath       *ManagedPath         `json:"managedPath,omitempty"`
	ReportDigest      string               `json:"reportDigest,omitempty"`
	Scope             domain.InstanceScope `json:"scope"`
	Target            Target               `json:"target"`
	RequestedBy       string               `json:"requestedBy"`
	RequestedAt       time.Time            `json:"requestedAt"`
	ExpiresAt         time.Time            `json:"expiresAt"`
	Direction         string               `json:"direction"`
	EstimatedMaxBytes int64                `json:"estimatedMaxBytes"`
	CostBasis         string               `json:"costBasis"`
	Status            string               `json:"status"`
	ClaimedAt         *time.Time           `json:"claimedAt,omitempty"`
	AttemptID         string               `json:"attemptId,omitempty"`
	Result            *Result              `json:"result,omitempty"`
}
type Result struct {
	Status         string    `json:"status"`
	Phase          string    `json:"phase"`
	Code           string    `json:"code"`
	Action         string    `json:"action"`
	StartedAt      time.Time `json:"startedAt"`
	FinishedAt     time.Time `json:"finishedAt"`
	DurationMS     int64     `json:"durationMs"`
	BytesSent      int64     `json:"bytesSent"`
	BytesReceived  int64     `json:"bytesReceived"`
	CostKnown      bool      `json:"costKnown"`
	BytesPerSecond *float64  `json:"bytesPerSecond,omitempty"`
	HTTPStatus     int       `json:"httpStatus,omitempty"`
}
type Report struct {
	JobID     string               `json:"jobId"`
	Scope     domain.InstanceScope `json:"scope"`
	AttemptID string               `json:"attemptId"`
	Result    Result               `json:"result"`
}

func NewJob(r Request, t Target, s domain.InstanceScope, actor string, now time.Time) (Job, error) {
	if r.PathMode != "" && r.PathMode != "node_direct" && r.PathMode != "managed_route" {
		return Job{}, ErrInvalid
	}
	if (r.PathMode == "managed_route") != (r.PublishedRouteID != "") {
		return Job{}, ErrInvalid
	}
	if e := t.Validate(); e != nil {
		return Job{}, e
	}
	if !domain.ValidID(r.ID) || !domain.ValidID(r.InstanceID) || !domain.ValidID(s.EnrollmentEpoch) || r.TargetID != t.ID || !slices.Contains(t.Methods, r.Kind) || r.TimeoutSeconds < 1 || r.TimeoutSeconds > MaxTimeoutSeconds || r.MaxBytes < 0 || r.MaxBytes > MaxPayloadBytes || actor == "" || now.IsZero() {
		return Job{}, ErrInvalid
	}
	if r.InstanceID != s.InstanceID || t.NodeID != s.NodeID {
		return Job{}, ErrScope
	}
	direction := "node_to_target"
	cost := r.MaxBytes
	if r.Kind == "connectivity" {
		if r.MaxBytes != 0 {
			return Job{}, ErrInvalid
		}
	} else if r.MaxBytes < 1024 {
		return Job{}, ErrInvalid
	}
	if r.Kind == "download" {
		direction = "target_to_node"
	}
	if r.Kind == "upload" {
		cost += UploadResponseBytes
	}
	return Job{Request: r, Scope: s, Target: t, RequestedBy: actor, RequestedAt: now, ExpiresAt: now.Add(2 * time.Minute), Direction: direction, EstimatedMaxBytes: cost, CostBasis: "application_payload_not_wire_or_provider_billing", Status: "queued"}, nil
}
func (j Job) Validate(scope domain.InstanceScope) error {
	if j.Scope != scope {
		return ErrScope
	}
	if j.PathMode == "managed_route" {
		if j.ManagedPath == nil {
			return ErrInvalid
		}
		if e := j.ManagedPath.Validate(scope, j.PublishedRouteID); e != nil {
			return e
		}
	} else if j.ManagedPath != nil {
		return ErrInvalid
	}
	canonical, e := NewJob(j.Request, j.Target, j.Scope, j.RequestedBy, j.RequestedAt)
	if e != nil {
		return e
	}
	if canonical.Direction != j.Direction || canonical.EstimatedMaxBytes != j.EstimatedMaxBytes || canonical.CostBasis != j.CostBasis || !canonical.ExpiresAt.Equal(j.ExpiresAt) {
		return ErrInvalid
	}
	return nil
}
func Terminal(status string) bool {
	return slices.Contains([]string{"succeeded", "failed", "not_run", "cancelled", "unknown"}, status)
}
func Digest(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func (r Report) Validate(j Job) error {
	if r.JobID != j.ID || r.Scope != j.Scope || r.AttemptID == "" || r.AttemptID != j.AttemptID {
		return ErrScope
	}
	v := r.Result
	if !Terminal(v.Status) || len(v.Code) < 1 || len(v.Code) > 64 || len(v.Phase) < 1 || len(v.Phase) > 32 || len(v.Action) > 512 || v.StartedAt.IsZero() || v.FinishedAt.Before(v.StartedAt) || v.DurationMS < 0 || v.BytesSent < 0 || v.BytesReceived < 0 || v.BytesSent+v.BytesReceived > j.EstimatedMaxBytes {
		return ErrInvalid
	}
	if j.Kind != "upload" && v.BytesSent != 0 || j.Kind == "upload" && (v.BytesSent > j.MaxBytes || v.BytesReceived > UploadResponseBytes) || j.Kind == "connectivity" && v.BytesReceived != 0 {
		return ErrInvalid
	}
	if v.Status == "succeeded" && (!v.CostKnown || v.Code != "completed" || v.HTTPStatus < 200 || v.HTTPStatus >= 300) {
		return ErrInvalid
	}
	if v.DurationMS != v.FinishedAt.Sub(v.StartedAt).Milliseconds() {
		return ErrInvalid
	}
	if v.Status == "succeeded" {
		if v.Phase != "complete" {
			return ErrInvalid
		}
		if j.Kind == "download" && v.BytesReceived != j.MaxBytes || j.Kind == "upload" && v.BytesSent != j.MaxBytes {
			return ErrInvalid
		}
		if j.Kind != "connectivity" && v.BytesPerSecond == nil {
			return ErrInvalid
		}
	}
	if v.Status == "unknown" && v.CostKnown {
		return ErrInvalid
	}
	if v.Status == "not_run" && (v.BytesSent != 0 || v.BytesReceived != 0 || !v.CostKnown) {
		return ErrInvalid
	}
	if v.BytesPerSecond != nil {
		if j.Kind == "connectivity" || v.Status != "succeeded" || math.IsNaN(*v.BytesPerSecond) || math.IsInf(*v.BytesPerSecond, 0) || *v.BytesPerSecond <= 0 {
			return ErrInvalid
		}
	}
	if v.BytesPerSecond != nil {
		seconds := v.FinishedAt.Sub(v.StartedAt).Seconds()
		if seconds <= 0 {
			return ErrInvalid
		}
		payload := v.BytesReceived
		if j.Kind == "upload" {
			payload = v.BytesSent
		}
		expected := float64(payload) / seconds
		if math.Abs(*v.BytesPerSecond-expected) > expected*0.000001 {
			return ErrInvalid
		}
	}
	return nil
}
