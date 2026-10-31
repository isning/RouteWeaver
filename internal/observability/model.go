// Package observability owns node observation continuity and provider allowance
// estimates. It never reads the operating system, persists data, or uses tenant
// traffic accounting. A NIC estimate is not a provider billing statement.
package observability

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"routeweaver/internal/domain"
	"strings"
	"time"
)

const FreshFor = 15 * time.Minute

var ErrConflict = errors.New("node observation conflict")
var ErrScope = errors.New("node observer scope mismatch")

type Interface struct {
	Name          string `json:"name"`
	ReceiveBytes  uint64 `json:"receiveBytes"`
	TransmitBytes uint64 `json:"transmitBytes"`
}
type Metrics struct {
	CounterEpoch         string      `json:"counterEpoch"`
	CPUTotalTicks        uint64      `json:"cpuTotalTicks"`
	CPUIdleTicks         uint64      `json:"cpuIdleTicks"`
	MemoryTotalBytes     uint64      `json:"memoryTotalBytes"`
	MemoryAvailableBytes uint64      `json:"memoryAvailableBytes"`
	Load1                float64     `json:"load1"`
	Load5                float64     `json:"load5"`
	Load15               float64     `json:"load15"`
	Interfaces           []Interface `json:"interfaces"`
}

// Scope uses the canonical pure identity rather than coupling persistence to
// a transport protocol. Authentication is checked at the adapter boundary.
type Scope = domain.InstanceScope

type Report struct {
	Scope       Scope     `json:"scope"`
	StreamEpoch string    `json:"streamEpoch"`
	Sequence    uint64    `json:"sequence"`
	ObservedAt  time.Time `json:"observedAt"`
	Metrics     Metrics   `json:"metrics"`
	Digest      string    `json:"digest"`
}
type Receipt struct {
	StreamEpoch string `json:"streamEpoch"`
	Sequence    uint64 `json:"sequence"`
	Digest      string `json:"digest"`
	Duplicate   bool   `json:"duplicate"`
}
type ProviderConfig struct {
	Name               string     `json:"name"`
	Mode               string     `json:"mode"`
	Allowance          uint64     `json:"allowance"`
	Unit               string     `json:"unit"`
	CycleID            string     `json:"cycleId"`
	CycleStart         time.Time  `json:"cycleStart"`
	CycleEnd           time.Time  `json:"cycleEnd"`
	ExpiresAt          *time.Time `json:"expiresAt,omitempty"`
	NotificationSource string     `json:"notificationSource"`
	ExhaustionAction   string     `json:"exhaustionAction"`
}
type Config struct {
	Revision           uint64          `json:"revision"`
	ObserverInstanceID string          `json:"observerInstanceId"`
	BilledInterfaces   []string        `json:"billedInterfaces"`
	Provider           *ProviderConfig `json:"provider"`
}
type BaselineInput struct {
	CycleID      string `json:"cycleId"`
	UsedBytes    int64  `json:"usedBytes"`
	ReportDigest string `json:"reportDigest"`
	Reason       string `json:"reason"`
}
type Baseline struct {
	BaselineInput
	ObservedAt         time.Time `json:"observedAt"`
	RecordedAt         time.Time `json:"recordedAt"`
	ActorID            string    `json:"actorId"`
	NICBytesAtBaseline int64     `json:"nicBytesAtBaseline"`
}
type StatementInput struct {
	CycleID    string    `json:"cycleId"`
	UsedBytes  int64     `json:"usedBytes"`
	ObservedAt time.Time `json:"observedAt"`
	Reference  string    `json:"reference"`
}
type Statement struct {
	StatementInput
	RecordedAt time.Time `json:"recordedAt"`
	ActorID    string    `json:"actorId"`
}
type Snapshot struct {
	Report
	ReceivedAt             time.Time `json:"receivedAt"`
	CPUPercent             *float64  `json:"cpuPercent"`
	ReceiveBytesPerSecond  *float64  `json:"receiveBytesPerSecond"`
	TransmitBytesPerSecond *float64  `json:"transmitBytesPerSecond"`
	Continuity             string    `json:"continuity"`
	Source                 string    `json:"source"`
}

// State is persisted atomically per physical NodeID, independent of core count.
type State struct {
	Config           Config     `json:"config"`
	Latest           *Snapshot  `json:"latest"`
	ObservedNICBytes int64      `json:"observedNicBytes"`
	ObservedSince    *time.Time `json:"observedSince"`
	CoverageReason   string     `json:"coverageReason"`
	Baseline         *Baseline  `json:"baseline"`
	Statement        *Statement `json:"statement"`
}
type ProviderView struct {
	Source               string     `json:"source"`
	Coverage             string     `json:"coverage"`
	StatusReason         string     `json:"statusReason"`
	Fresh                bool       `json:"fresh"`
	ObservedAt           *time.Time `json:"observedAt"`
	ObservedSince        *time.Time `json:"observedSince"`
	ObservedNICBytes     int64      `json:"observedNicBytes"`
	TotalBytes           *int64     `json:"totalBytes"`
	UsedBytes            *int64     `json:"usedBytes"`
	RemainingBytes       *int64     `json:"remainingBytes"`
	ExhaustionAction     string     `json:"exhaustionAction"`
	NotificationEligible bool       `json:"notificationEligible"`
}
type View struct {
	NodeID    string       `json:"nodeId"`
	Config    Config       `json:"config"`
	Latest    *Snapshot    `json:"latest"`
	Provider  ProviderView `json:"provider"`
	Baseline  *Baseline    `json:"baseline"`
	Statement *Statement   `json:"statement"`
}

func ReportDigest(r Report) string {
	r.Digest = ""
	b, _ := json.Marshal(r)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func validInterface(name string) bool {
	return name != "" && len(name) <= 64 && !strings.ContainsAny(name, " \t\n\r\x00/:\\")
}
func text(s string, max int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= max && !strings.ContainsRune(s, 0)
}
func TotalBytes(c ProviderConfig) (int64, error) {
	factors := map[string]uint64{"bytes": 1, "GB": 1000000000, "TB": 1000000000000, "GiB": 1 << 30, "TiB": 1 << 40}
	factor, ok := factors[c.Unit]
	if !ok || c.Allowance == 0 || c.Allowance > math.MaxInt64/factor {
		return 0, errors.New("positive allowance with explicit bytes, GB, TB, GiB or TiB unit required")
	}
	return int64(c.Allowance * factor), nil
}
func ValidateConfig(c Config) error {
	if c.ObserverInstanceID != "" && !domain.ValidID(c.ObserverInstanceID) {
		return errors.New("invalid observer instance")
	}
	if len(c.BilledInterfaces) > 32 {
		return errors.New("at most 32 explicitly billed interfaces allowed")
	}
	seen := map[string]bool{}
	for _, name := range c.BilledInterfaces {
		if !validInterface(name) || seen[name] || name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "cni") || strings.HasPrefix(name, "br-") {
			return errors.New("select unique provider-facing billed interfaces, not loopback/container interfaces")
		}
		seen[name] = true
	}
	if c.Provider == nil {
		return nil
	}
	p := *c.Provider
	if !text(p.Name, 160) {
		return errors.New("provider name required")
	}
	// Unlimited service may have no allowance reset cycle. Requiring dates here
	// would pressure operators to invent provider billing facts.
	noCycle := p.CycleID == "" && p.CycleStart.IsZero() && p.CycleEnd.IsZero()
	if !(p.Mode == "unlimited" && noCycle) && (!domain.ValidID(p.CycleID) || p.CycleStart.IsZero() || !p.CycleEnd.After(p.CycleStart) || p.CycleEnd.Sub(p.CycleStart) > 366*24*time.Hour) {
		return errors.New("limited allowance requires explicit cycle identity/start/end within 366 days")
	}
	if p.Mode != "limited" && p.Mode != "unlimited" {
		return errors.New("provider mode must be limited or unlimited")
	}
	if p.Mode == "limited" {
		if _, e := TotalBytes(p); e != nil {
			return e
		}
	} else if p.Allowance != 0 {
		return errors.New("unlimited allowance must not contain a numeric limit")
	}
	if p.NotificationSource != "none" && p.NotificationSource != "provider_statement" && p.NotificationSource != "nic_estimate" {
		return errors.New("select an explicit notification source")
	}
	if p.NotificationSource == "nic_estimate" && len(c.BilledInterfaces) == 0 {
		return errors.New("NIC estimate requires explicit billed interfaces")
	}
	if p.ExhaustionAction != "advisory" {
		return errors.New("provider exhaustion is advisory; no automatic route or exit changes")
	}
	return nil
}
func ValidateReport(r Report, now time.Time) error {
	if !domain.ValidID(r.Scope.NodeID) || !domain.ValidID(r.Scope.InstanceID) || !domain.ValidID(r.Scope.EnrollmentEpoch) || !domain.ValidID(r.StreamEpoch) || !domain.ValidID(r.Metrics.CounterEpoch) || r.Sequence == 0 {
		return errors.New("valid node scope, observer epochs and sequence required")
	}
	if r.ObservedAt.IsZero() || r.ObservedAt.After(now.Add(time.Minute)) || now.Sub(r.ObservedAt) > 24*time.Hour {
		return errors.New("node observation time outside accepted window")
	}
	m := r.Metrics
	if m.CPUTotalTicks == 0 || m.CPUIdleTicks > m.CPUTotalTicks || m.MemoryTotalBytes == 0 || m.MemoryAvailableBytes > m.MemoryTotalBytes || len(m.Interfaces) > 128 {
		return errors.New("invalid or excessive node resource measurements")
	}
	for _, v := range []float64{m.Load1, m.Load5, m.Load15} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return errors.New("invalid load measurement")
		}
	}
	names := map[string]bool{}
	for _, n := range m.Interfaces {
		if !validInterface(n.Name) || names[n.Name] {
			return errors.New("invalid or duplicate NIC measurement")
		}
		names[n.Name] = true
	}
	if r.Digest != ReportDigest(r) {
		return errors.New("node observation digest mismatch")
	}
	return nil
}
func currentCycle(p *ProviderConfig, at time.Time) bool {
	return p != nil && (p.Mode == "unlimited" && p.CycleID == "" && p.CycleStart.IsZero() && p.CycleEnd.IsZero() || !at.Before(p.CycleStart) && at.Before(p.CycleEnd))
}
func fresh(at, now time.Time) bool {
	return !at.IsZero() && !at.After(now.Add(time.Minute)) && now.Sub(at) <= FreshFor
}
func Add(a, b int64) (int64, error) {
	if a < 0 || b < 0 || a > math.MaxInt64-b {
		return 0, errors.New("node counter exceeds supported byte range")
	}
	return a + b, nil
}
func conflict(reason string) error { return fmt.Errorf("%w: %s", ErrConflict, reason) }
