package httpapi

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

const maxNodeChangeRows = 50

type outputNodeChanges struct {
	Version int    `json:"version"`
	State   string `json:"state"`
	*outputNodeChangeDetails
}
type outputNodeChangeDetails struct {
	BeforeCount       int                   `json:"beforeCount"`
	AfterCount        int                   `json:"afterCount"`
	AddedCount        int                   `json:"addedCount"`
	RemovedCount      int                   `json:"removedCount"`
	ModifiedCount     int                   `json:"modifiedCount"`
	AffectedNodeCount int                   `json:"affectedNodeCount"`
	OrderChanged      bool                  `json:"orderChanged"`
	Rows              []outputNodeChangeRow `json:"rows"`
	OmittedRowCount   int                   `json:"omittedRowCount"`
}
type outputNodeChangeRow struct {
	Kind            string `json:"kind"`
	Label           string `json:"label"`
	BeforeLabel     string `json:"beforeLabel,omitempty"`
	NameChanged     bool   `json:"nameChanged,omitempty"`
	SettingsChanged bool   `json:"settingsChanged,omitempty"`
}

// Derived only from the selected frozen output and its exact prepared candidate.
// Neither persisted metadata nor artifact comparison semantics are modified.
func compareOutputNodes(published Output, candidate preparedOutput) *outputNodeChanges {
	next := candidate.output
	if published.Mode != render.NodesOnly && next.Mode != render.NodesOnly {
		return nil
	}
	result := &outputNodeChanges{Version: 1, State: "unavailable"}
	if published.ID != next.ID || published.ProfileID != next.ProfileID || published.Target != next.Target || published.Mode != next.Mode || candidate.result.NativeOverride != nil || !knownPortableOutput(published) || !knownPortableOutput(next) {
		return result
	}
	before, err := render.InspectNodesOnly(published.Target, published.Mode, published.Artifacts, published.NameAllocations)
	if err != nil {
		return result
	}
	after, err := render.InspectNodesOnly(next.Target, next.Mode, next.Artifacts, next.NameAllocations)
	if err != nil {
		return result
	}
	// Secret-only carriers bridge the existing sanitizer; these are not reconstructed
	// domain connections and are never rendered, persisted, or returned to callers.
	protected := []domain.ClientEndpoint{}
	for _, nodes := range [][]render.InspectedNode{before, after} {
		for _, node := range nodes {
			for _, secret := range node.ProtectedStrings() {
				protected = append(protected, domain.ClientEndpoint{Connection: domain.Connection{Password: secret}})
			}
		}
	}
	sanitize := routingLabelSanitizer(protected)
	safeLabel := func(value string) string {
		label := []rune(sanitize(value))
		if len(label) > 240 {
			return string(label[:240]) + "…"
		}
		return string(label)
	}
	old := map[string]render.InspectedNode{}
	current := map[string]render.InspectedNode{}
	for _, n := range before {
		old[n.ID()] = n
	}
	for _, n := range after {
		current[n.ID()] = n
	}
	detail := &outputNodeChangeDetails{BeforeCount: len(before), AfterCount: len(after), Rows: []outputNodeChangeRow{}}
	add := func(row outputNodeChangeRow) {
		detail.AffectedNodeCount++
		if len(detail.Rows) < maxNodeChangeRows {
			detail.Rows = append(detail.Rows, row)
		} else {
			detail.OmittedRowCount++
		}
	}
	for _, n := range after {
		previous, exists := old[n.ID()]
		if !exists {
			detail.AddedCount++
			add(outputNodeChangeRow{Kind: "added", Label: safeLabel(n.Name())})
			continue
		}
		renamed, settings := previous.Name() != n.Name(), !previous.SameSettings(n)
		if renamed || settings {
			detail.ModifiedCount++
			row := outputNodeChangeRow{Kind: "modified", Label: safeLabel(n.Name()), NameChanged: renamed, SettingsChanged: settings}
			if renamed {
				row.BeforeLabel = safeLabel(previous.Name())
			}
			add(row)
		}
	}
	oldOrder, nextOrder := []string{}, []string{}
	for _, n := range before {
		if _, exists := current[n.ID()]; !exists {
			detail.RemovedCount++
			add(outputNodeChangeRow{Kind: "removed", Label: safeLabel(n.Name())})
		} else {
			oldOrder = append(oldOrder, n.ID())
		}
	}
	for _, n := range after {
		if _, exists := old[n.ID()]; exists {
			nextOrder = append(nextOrder, n.ID())
		}
	}
	for i, id := range oldOrder {
		if nextOrder[i] != id {
			detail.OrderChanged = true
			break
		}
	}
	result.State = "available"
	result.outputNodeChangeDetails = detail
	return result
}
