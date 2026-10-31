package httpapi

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
)

func fleetConfigDiff(previous, next []domain.Artifact) []fleet.ConfigChange {
	old, new := map[string]string{}, map[string]string{}
	for _, a := range previous {
		old[a.Path] = a.Content
	}
	for _, a := range next {
		new[a.Path] = a.Content
	}
	out := []fleet.ConfigChange{}
	preview := func(content string) string {
		if content == "" {
			return ""
		}
		redacted := redactArtifact(content)
		if len(redacted) > 16384 {
			return redacted[:16384] + "\n[Preview truncated]"
		}
		return redacted
	}
	for _, path := range fleet.ChangedArtifacts(previous, next) {
		out = append(out, fleet.ConfigChange{Path: path, Before: preview(old[path]), After: preview(new[path])})
	}
	return out
}
