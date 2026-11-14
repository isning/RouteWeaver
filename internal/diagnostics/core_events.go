package diagnostics

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"routeweaver/internal/domain"
	"strings"
	"time"
)

const CoreBatchLimit = 32
const CoreHistoryLimit = 128
const CoreInstanceLimit = 256
const CoreRetention = 24 * time.Hour
const CoreCounterLimit = 1000000

var ErrCoreConflict = errors.New("core diagnostic sequence conflict")
var ErrCoreCapacity = errors.New("core diagnostic capacity reached")
var ErrCoreRate = errors.New("core diagnostics report rate exceeded")

// CoreEvent contains fixed, version-qualified categories, never core output,
// addresses, paths, tags, usernames, credentials or excerpts of unknown text.
type CoreEvent struct {
	AdapterID  string    `json:"adapterId"`
	Version    string    `json:"version"`
	Code       string    `json:"code"`
	ObservedAt time.Time `json:"observedAt"`
}
type CoreReport struct {
	Scope    domain.InstanceScope `json:"scope"`
	Sequence uint64               `json:"sequence,string"`
	Events   []CoreEvent          `json:"events"`
	Omitted  uint32               `json:"omitted"`
	Dropped  uint32               `json:"dropped"`
	Digest   string               `json:"digest"`
}
type CoreReceipt struct {
	Sequence  uint64 `json:"sequence,string"`
	Digest    string `json:"digest"`
	Duplicate bool   `json:"duplicate"`
}
type CoreRecord struct {
	CoreEvent
	ReceivedAt time.Time `json:"receivedAt"`
}
type CoreHistory struct {
	Scope          domain.InstanceScope `json:"scope"`
	Sequence       uint64               `json:"sequence,string"`
	Digest         string               `json:"digest"`
	LastReceivedAt *time.Time           `json:"lastReceivedAt"`
	Events         []CoreRecord         `json:"events"`
	Omitted        uint32               `json:"omitted"`
	Dropped        uint32               `json:"dropped"`
}

func CoreSupported(adapter, version string) bool {
	return adapter == "routeweaver/xray" && (version == "26.3.27" || version == "26.10.31") || adapter == "routeweaver/sing-box" && (version == "1.14.3" || version == "1.14.4")
}
func ValidCoreCode(adapter, version, code string) bool {
	if !CoreSupported(adapter, version) {
		return false
	}
	switch code {
	case "tls_certificate_file_missing", "unsupported_protocol_configuration":
		return true
	case "listener_address_in_use":
		return adapter == "routeweaver/xray"
	case "network_initialization_permission_denied":
		return adapter == "routeweaver/sing-box"
	}
	return false
}
func CoreReportDigest(r CoreReport) string {
	r.Digest = ""
	b, _ := json.Marshal(r)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (r CoreReport) Validate(now time.Time) error {
	if !domain.ValidID(r.Scope.NodeID) || !domain.ValidID(r.Scope.InstanceID) || !domain.ValidID(r.Scope.EnrollmentEpoch) || r.Sequence == 0 || len(r.Events) > CoreBatchLimit || r.Omitted > CoreCounterLimit || r.Dropped > CoreCounterLimit || r.Digest != CoreReportDigest(r) {
		return ErrInvalid
	}
	for _, e := range r.Events {
		if !ValidCoreCode(e.AdapterID, e.Version, e.Code) || e.ObservedAt.Before(time.Unix(0, 0)) || e.ObservedAt.After(now.Add(5*time.Minute)) {
			return ErrInvalid
		}
	}
	return nil
}
func PruneCoreHistory(h *CoreHistory, now time.Time) {
	kept := make([]CoreRecord, 0, len(h.Events))
	for _, e := range h.Events {
		if e.ReceivedAt.After(now.Add(-CoreRetention)) {
			kept = append(kept, e)
		}
	}
	if len(kept) > CoreHistoryLimit {
		kept = kept[len(kept)-CoreHistoryLimit:]
	}
	h.Events = kept
}

var coreANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var singCertificate = regexp.MustCompile(`^FATAL\[[0-9]+\] create service: initialize inbound\[[0-9]+\]: read certificate: open [^\r\n]+: no such file or directory$`)
var singProtocol = regexp.MustCompile(`^FATAL\[[0-9]+\] decode config at [^\r\n]+: inbounds\[[0-9]+\]: unknown inbound type: [^\r\n]+$`)
var singNetwork = regexp.MustCompile(`^FATAL\[[0-9]+\] start service: initialize network: create netlink socket: operation not permitted$`)

// ClassifyCoreLine identifies a core-reported category, not trusted runtime
// success/failure evidence. It intentionally has no string capture return path.
func ClassifyCoreLine(adapter, version, line string) string {
	if !CoreSupported(adapter, version) || len(line) > 4096 {
		return ""
	}
	s := coreANSI.ReplaceAllString(line, "")
	for _, r := range s {
		if r < 32 || r == 127 {
			return ""
		}
	}
	if adapter == "routeweaver/xray" {
		listenPhrase := " > transport/internet/tcp: failed to listen TCP on "
		if version == "26.10.31" {
			listenPhrase = " > transport/internet/tcp: failed to listen tcp on "
		}
		if strings.HasPrefix(s, "Failed to start: ") && strings.HasSuffix(s, ": bind: address already in use") && strings.Contains(s, listenPhrase) {
			return "listener_address_in_use"
		}
		if strings.HasPrefix(s, "Failed to start: main: failed to load config files: ") {
			if strings.Contains(s, " > infra/conf: Failed to build TLS config. > infra/conf: failed to parse certificate > open ") && strings.HasSuffix(s, ": no such file or directory") {
				return "tls_certificate_file_missing"
			}
			if strings.Contains(s, " > infra/conf: unknown config id: ") {
				return "unsupported_protocol_configuration"
			}
		}
	} else {
		if singCertificate.MatchString(s) {
			return "tls_certificate_file_missing"
		}
		if singProtocol.MatchString(s) {
			return "unsupported_protocol_configuration"
		}
		if singNetwork.MatchString(s) {
			return "network_initialization_permission_denied"
		}
	}
	return ""
}
