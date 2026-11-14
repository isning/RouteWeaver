package httpapi

import "routeweaver/internal/store"

// CAS uses the original database records; authority hashes bind the post-commit
// view instead. Keeping these separate prevents an overlay from weakening CAS
// or producing a service that blocks itself immediately after the atomic commit.
func fleetOverlayCompares(compares []store.RecordCompare, overlay map[string]store.RecordWrite) []store.RecordCompare {
	result := append([]store.RecordCompare{}, compares...)
	for i, c := range result {
		if w, ok := overlay[c.Kind+"\x00"+c.ID]; ok {
			result[i].Expected = w.Value
		}
	}
	return result
}
