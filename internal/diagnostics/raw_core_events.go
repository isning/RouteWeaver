package diagnostics

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"routeweaver/internal/domain"
	"unicode/utf8"

	"time"
)

const RawCoreBatchLimit = 16
const RawCoreHistoryLimit = 128
const RawCoreInstanceLimit = 64
const RawCoreRetention = time.Hour
const RawCoreCounterLimit = 1000000

var ErrRawCoreConflict = errors.New("core diagnostic sequence conflict")
var ErrRawCoreCapacity = errors.New("core diagnostic capacity reached")
var ErrRawCoreRate = errors.New("core diagnostics report rate exceeded")

// RawCoreEvent is unredacted sensitive process output. Separate explicit opt-in only.
type RawCoreEvent struct {
	AdapterID  string    `json:"adapterId"`
	Version    string    `json:"version"`
	Stream     string    `json:"stream"`
	Text       string    `json:"text"`
	ObservedAt time.Time `json:"observedAt"`
}
type RawCoreReport struct {
	Scope    domain.InstanceScope `json:"scope"`
	Session  string               `json:"session"`
	Sequence uint64               `json:"sequence,string"`
	Events   []RawCoreEvent       `json:"events"`
	Omitted  uint32               `json:"omitted"`
	Dropped  uint32               `json:"dropped"`
	Digest   string               `json:"digest"`
}
type RawCoreReceipt struct {
	Sequence  uint64 `json:"sequence,string"`
	Digest    string `json:"digest"`
	Duplicate bool   `json:"duplicate"`
}
type RawCoreRecord struct {
	RawCoreEvent
	ReceivedAt time.Time `json:"receivedAt"`
}
type RawCoreHistory struct {
	Scope          domain.InstanceScope `json:"scope"`
	Session        string               `json:"session"`
	Sequence       uint64               `json:"sequence,string"`
	Digest         string               `json:"digest"`
	LastReceivedAt *time.Time           `json:"lastReceivedAt"`
	Events         []RawCoreRecord      `json:"events"`
	Omitted        uint32               `json:"omitted"`
	Dropped        uint32               `json:"dropped"`
}

func RawCoreReportDigest(r RawCoreReport) string {
	r.Digest = ""
	b, _ := json.Marshal(r)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (r RawCoreReport) Validate(now time.Time) error {
	if !domain.ValidID(r.Scope.NodeID) || !domain.ValidID(r.Scope.InstanceID) || !domain.ValidID(r.Scope.EnrollmentEpoch) || !domain.ValidID(r.Session) || r.Sequence == 0 || len(r.Events) > RawCoreBatchLimit || r.Omitted > RawCoreCounterLimit || r.Dropped > RawCoreCounterLimit || r.Digest != RawCoreReportDigest(r) {
		return ErrInvalid
	}
	for _, e := range r.Events {
		if (e.AdapterID != "routeweaver/xray" && e.AdapterID != "routeweaver/sing-box" && e.AdapterID != "routeweaver/managed-xray") || len(e.Version) > 128 || (e.Stream != "stdout" && e.Stream != "stderr") || len(e.Text) > 4096 || !utf8.ValidString(e.Text) || e.ObservedAt.Before(time.Unix(0, 0)) || e.ObservedAt.After(now.Add(5*time.Minute)) {
			return ErrInvalid
		}
	}
	return nil
}
func PruneRawCoreHistory(h *RawCoreHistory, now time.Time) {
	kept := make([]RawCoreRecord, 0, len(h.Events))
	for _, e := range h.Events {
		if e.ReceivedAt.After(now.Add(-RawCoreRetention)) && e.ObservedAt.After(now.Add(-RawCoreRetention)) {
			kept = append(kept, e)
		}
	}
	if len(kept) > RawCoreHistoryLimit {
		kept = kept[len(kept)-RawCoreHistoryLimit:]
	}
	h.Events = kept
}
