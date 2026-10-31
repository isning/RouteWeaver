package httpapi

import (
	"encoding/hex"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// A positive input refresh fact, not an exhaustive diff or client application proof.
// Dependency identities and hashes remain private; no historical names are inferred.
type outputPlatformEntryRefresh struct {
	Version int `json:"version"`
	Count   int `json:"count"`
}

func platformEntryRefresh(outputID, profileID string, published Output, candidate preparedOutput) *outputPlatformEntryRefresh {
	next := candidate.output
	if !domain.ValidID(published.ID) || !domain.ValidID(published.ProfileID) || published.ID != outputID || published.ProfileID != profileID || published.ID != next.ID || published.ProfileID != next.ProfileID || published.Target != next.Target || published.Mode != next.Mode || candidate.result.NativeOverride != nil {
		return nil
	}
	if !knownPortableOutput(published) || !knownPortableOutput(next) {
		return nil
	}
	before, ok := knownEntryDependencies(published.PlatformDependencies)
	if !ok {
		return nil
	}
	after, ok := knownEntryDependencies(next.PlatformDependencies)
	if !ok {
		return nil
	}
	count := 0
	for id, old := range before {
		current, exists := after[id]
		if exists && old.RouteID == current.RouteID && (old.CredentialVersion != current.CredentialVersion || old.ConnectionDigest != current.ConnectionDigest) {
			count++
		}
	}
	if count == 0 {
		return nil
	}
	return &outputPlatformEntryRefresh{Version: 1, Count: count}
}

func knownPortableOutput(output Output) bool {
	switch output.Target.AdapterID {
	case "mihomo":
		if output.Target.Version != render.MihomoVersion {
			return false
		}
	case "sing-box":
		if output.Target.Version != render.SingBoxVersion {
			return false
		}
	default:
		return false
	}
	summary := output.RoutingSummary
	if summary == nil || summary.Version != 1 {
		return false
	}
	expectedIntent := "portable"
	switch output.Mode {
	case render.NodesOnly:
		if summary.Kind != "nodes-only" {
			return false
		}
		expectedIntent = "nodes-only"
	case render.FullConfig:
		if summary.Kind != "basic" && summary.Kind != "advanced" {
			return false
		}
	default:
		return false
	}
	// An absent older private policy snapshot is compatible with a known summary;
	// an explicitly unknown or contradictory snapshot is not positive evidence.
	if intent := output.RoutingIntent; intent != nil && (intent.Version != 1 || intent.Kind != expectedIntent) {
		return false
	}
	return true
}

func knownEntryDependencies(values []EntryDependency) (map[string]EntryDependency, bool) {
	result := make(map[string]EntryDependency, len(values))
	for _, value := range values {
		if !domain.ValidID(value.ID) || !domain.ValidID(value.RouteID) || !domain.ValidID(value.CredentialVersion) || len(value.ConnectionDigest) != 64 {
			return nil, false
		}
		if decoded, err := hex.DecodeString(value.ConnectionDigest); err != nil || hex.EncodeToString(decoded) != value.ConnectionDigest {
			return nil, false
		}
		if _, duplicate := result[value.ID]; duplicate {
			return nil, false
		}
		result[value.ID] = value
	}
	return result, true
}
