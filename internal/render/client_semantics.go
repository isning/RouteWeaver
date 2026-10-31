package render

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"routeweaver/internal/domain"
)

// Each category is complete or unavailable. These optional metadata budgets do
// not limit rendering or publication; callers may omit metadata at record limits.
const maxSemanticCategoryBytes = 64 << 10

// SemanticSnapshot is private publication comparison material, not an API DTO.
// Labels are allocated output names, not yet safe for display. Fingerprints must
// never be returned to clients. HTTP review projects allowlisted facts after
// sanitizing labels against both publications' emitted credential values.
type SemanticSnapshot struct {
	Version int                   `json:"version"`
	Groups  SemanticGroupSnapshot `json:"groups"`
	Nodes   SemanticNodeSnapshot  `json:"nodes"`
}
type SemanticGroupSnapshot struct {
	State  string          `json:"state"`
	Reason string          `json:"reason,omitempty"`
	Items  []SemanticGroup `json:"items,omitempty"`
}
type SemanticNodeSnapshot struct {
	State  string         `json:"state"`
	Reason string         `json:"reason,omitempty"`
	Items  []SemanticNode `json:"items,omitempty"`
}
type SemanticGroup struct {
	ID               string             `json:"id"`
	Label            string             `json:"label"`
	Kind             string             `json:"kind"`
	Strategy         string             `json:"strategy,omitempty"`
	Members          []domain.ActionRef `json:"members"`
	ParametersDigest string             `json:"parametersDigest"`
}
type SemanticNode struct {
	ID              string            `json:"id"`
	Label           string            `json:"label"`
	SettingsDigest  string            `json:"settingsDigest"`
	CategoryDigests map[string]string `json:"categoryDigests"`
}

type semanticCapture struct {
	value                 SemanticSnapshot
	groupBytes, nodeBytes int
}

func newSemanticCapture(mode OutputMode) *semanticCapture {
	if mode != FullConfig {
		return nil
	}
	return &semanticCapture{value: SemanticSnapshot{Version: 1,
		Groups: SemanticGroupSnapshot{State: "available", Items: []SemanticGroup{}},
		Nodes:  SemanticNodeSnapshot{State: "available", Items: []SemanticNode{}},
	}, groupBytes: 64, nodeBytes: 64}
}

func (s *semanticCapture) snapshot() *SemanticSnapshot {
	if s == nil {
		return nil
	}
	return &s.value
}

func semanticDigest(value any) string {
	encoded, _ := json.Marshal(value) // Only emitted JSON-compatible objects enter.
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *semanticCapture) node(adapter, id string, emitted map[string]any) {
	if s == nil || s.value.Nodes.State != "available" {
		return
	}
	nameKey := "name"
	if adapter == "sing-box" {
		nameKey = "tag"
	}
	label, _ := emitted[nameKey].(string)
	settings := make(map[string]any, len(emitted))
	parts := map[string]map[string]any{}
	for _, category := range []string{"endpoint", "protocol", "authentication", "security", "transport", "protocol-options"} {
		parts[category] = map[string]any{}
	}
	for key, value := range emitted {
		if key == nameKey {
			continue
		}
		settings[key] = value
		category := "other"
		switch key {
		case "server", "port", "server_port":
			category = "endpoint"
		case "type", "version":
			category = "protocol"
		case "username", "password", "uuid":
			category = "authentication"
		case "tls", "sni", "servername", "client-fingerprint", "alpn", "reality-opts":
			category = "security"
		case "transport", "network", "ws-opts", "grpc-opts":
			category = "transport"
		case "cipher", "security", "alterId", "alter_id", "method", "flow", "packet-encoding", "packet_encoding":
			category = "protocol-options"
		}
		if parts[category] == nil {
			parts[category] = map[string]any{}
		}
		parts[category][key] = value
	}
	row := SemanticNode{ID: id, Label: label, SettingsDigest: semanticDigest(settings), CategoryDigests: map[string]string{}}
	for category, part := range parts {
		row.CategoryDigests[category] = semanticDigest(part)
	}
	encoded, err := json.Marshal(row)
	if err != nil || s.nodeBytes+len(encoded)+1 > maxSemanticCategoryBytes {
		s.value.Nodes = SemanticNodeSnapshot{State: "unavailable", Reason: "size-limit"}
		return
	}
	s.nodeBytes += len(encoded) + 1
	s.value.Nodes.Items = append(s.value.Nodes.Items, row)
}

func (s *semanticCapture) group(adapter, id, kind string, members []domain.ActionRef, emitted map[string]any) {
	if s == nil || s.value.Groups.State != "available" {
		return
	}
	nameKey, membersKey := "name", "proxies"
	if adapter == "sing-box" {
		nameKey, membersKey = "tag", "outbounds"
	}
	label, _ := emitted[nameKey].(string)
	strategy, _ := emitted["strategy"].(string)
	parameters := make(map[string]any, len(emitted))
	for key, value := range emitted {
		if key != nameKey && key != membersKey && key != "type" && key != "strategy" {
			parameters[key] = value
		}
	}
	row := SemanticGroup{ID: id, Label: label, Kind: kind, Strategy: strategy,
		Members: append([]domain.ActionRef{}, members...), ParametersDigest: semanticDigest(parameters)}
	encoded, err := json.Marshal(row)
	if err != nil || s.groupBytes+len(encoded)+1 > maxSemanticCategoryBytes {
		s.value.Groups = SemanticGroupSnapshot{State: "unavailable", Reason: "size-limit"}
		return
	}
	s.groupBytes += len(encoded) + 1
	s.value.Groups.Items = append(s.value.Groups.Items, row)
}
