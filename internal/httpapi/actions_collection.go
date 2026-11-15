package httpapi

import (
	"encoding/json"
	"routeweaver/internal/domain"
)

// Preflight saved collection inputs before the conversion pipeline allocates its
// per-step snapshots. All reads use the same budgeted manifest as comparison;
// the candidate cannot re-read a newer source after this check. There is no
// source refresh or external fetch here.
func actionCollectionWithinBudget(owner string, profile Profile, inputs *templateInputs) bool {
	sourceIDs := profile.SourceIDs
	if profile.CollectionID != "" {
		var collection domain.Collection
		if inputs.TenantGet(owner, "collections", profile.CollectionID, &collection) != nil || collection.OwnerID != owner || len(collection.Sources) > 16 {
			return false
		}
		if !actionStepsWithinBudget(collection.Steps) {
			return false
		}
		steps := len(collection.Steps)
		sourceIDs = make([]string, 0, len(collection.Sources))
		for _, source := range collection.Sources {
			if !actionStepsWithinBudget(source.Steps) {
				return false
			}
			steps += len(source.Steps)
			sourceIDs = append(sourceIDs, source.SourceID)
		}
		if steps > 32 {
			return false
		}
	}
	if len(sourceIDs) > 16 {
		return false
	}
	endpointCount := 0
	for _, id := range sourceIDs {
		var source Source
		if inputs.TenantGet(owner, "sources", id, &source) != nil || !source.Enabled || source.Snapshot == nil || source.Snapshot.OwnerID != owner {
			return false
		}
		if len(source.Snapshot.SourceName) > 160 {
			return false
		}
		for _, endpoint := range source.Snapshot.Endpoints {
			// Conversion clones stages; cap each endpoint before expanding stages.
			raw, err := json.Marshal(endpoint)
			if err != nil || len(raw) > 4096 || len(endpoint.Name) > 160 {
				return false
			}
		}
		endpointCount += len(source.Snapshot.Endpoints)
		if endpointCount > 256 {
			return false
		}
	}
	return true
}

func actionStepsWithinBudget(steps []domain.ProcessingStep) bool {
	if len(steps) > 32 {
		return false
	}
	for _, step := range steps {
		// A rename builds the replaced text before checking the final name.
		// Bound both the template and its substitutions before that allocation.
		raw, err := json.Marshal(step)
		if err != nil || len(raw) > 4096 || len(step.Template) > 160 || len(step.Filter.NamePattern) > 256 {
			return false
		}
	}
	return true
}
