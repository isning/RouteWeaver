package httpapi

import (
	"context"
	"fmt"
	"reflect"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

// This is an observation of a small, complete saved graph, never authorization
// to publish or deliver. Neither capture may truncate a dependency collection.
type platformComparisonReader struct {
	snapshot   *store.PlatformComparisonSnapshot
	validUntil time.Time
}

func (h *server) resolveComparisonEntry(owner, id string, reader *platformComparisonReader) (domain.ClientEndpoint, error) {
	var grant PublicEntryGrant
	if err := reader.snapshot.TenantGet(owner, "platform-entries", id, &grant); err != nil {
		return domain.ClientEndpoint{}, err
	}
	if !domain.ValidID(id) || grant.ID != id || grant.UserID != owner || grant.Revoked || grant.OutputID != "" || (grant.PublishedRouteID != "" && grant.PublishedRouteID != grant.RouteID) {
		return domain.ClientEndpoint{}, fmt.Errorf("platform comparison unavailable")
	}
	if err := reader.snapshot.Eligible(grant.RouteID); err != nil {
		return domain.ClientEndpoint{}, err
	}
	if grant.PublishedRouteID == "" {
		var route domain.PublishedRoute
		if err := reader.snapshot.Get("published-routes", grant.RouteID, &route); err != store.ErrNotFound {
			return domain.ClientEndpoint{}, fmt.Errorf("platform comparison unavailable")
		}
	} else {
		bundle, err := boundedPublishedPathBundle(reader.snapshot, time.Now, grant.PublishedRouteID)
		if err != nil {
			return domain.ClientEndpoint{}, err
		}
		connection, err := connectionForPublishedGrant(grant, bundle.Entry)
		if err != nil {
			return domain.ClientEndpoint{}, err
		}
		grant.Connection = connection
		if reader.validUntil.IsZero() || bundle.ValidUntil.Before(reader.validUntil) {
			reader.validUntil = bundle.ValidUntil
		}
	}
	return domain.ClientEndpoint{ID: grant.ID, Name: grant.Name, OwnerID: owner, Origin: "platform-entry", Connection: grant.Connection, Provenance: []domain.SourceRef{{SourceID: grant.RouteID, SnapshotID: grant.CredentialVersion, EndpointID: grant.ID}}}, nil
}

func smallPlatformComparison(output Output, p Profile) bool {
	return output.Attribution == nil && len(p.PlatformEntryIDs) > 0 && len(p.PlatformEntryIDs) <= 8 && len(p.SourceIDs) <= 16 && len(p.IR.Resources) <= 4 && len(p.IR.Endpoints) <= 32 && len(p.IR.Groups) <= 8 && len(p.IR.Rules) <= 32 && (p.IR.NativeOverride == nil || (p.IR.NativeOverride.Format == "json" && len(p.IR.NativeOverride.Content) <= 4096))
}

func (h *server) compareSmallPlatformDraft(ctx context.Context, owner string, output Output, budget *int) map[string]string {
	return h.compareSmallPlatformDraftUsing(ctx, owner, output, budget, h.s.PlatformComparisonSnapshot)
}
func (h *server) compareSmallPlatformDraftUsing(ctx context.Context, owner string, output Output, budget *int, capture func(context.Context, string, time.Time, *int) (*store.PlatformComparisonSnapshot, error)) map[string]string {
	unavailable := map[string]string{"state": "unavailable"}
	first, err := capture(ctx, owner, time.Now().UTC(), budget)
	if err != nil {
		return unavailable
	}
	var saved Output
	var p Profile
	if first.TenantGet(owner, "outputs", output.ID, &saved) != nil || !reflect.DeepEqual(saved, output) || first.TenantGet(owner, "profiles", output.ProfileID, &p) != nil || p.ID != output.ProfileID || !domain.ValidID(p.ID) || !smallPlatformComparison(output, p) {
		return unavailable
	}
	reader := &platformComparisonReader{snapshot: first}
	inputs := newTemplateInputs(h.s)
	inputs.platform = reader
	// Bound saved conversion stages before materialization. These reads and the
	// later conversion share the complete immutable first snapshot.
	if !actionCollectionWithinBudget(owner, p, inputs) || !withinPlatformResourceBudget(owner, p, inputs) {
		return unavailable
	}
	// This also opts into bounded rendering before recursive validation.
	comparison := h.compareOutputDraft(owner, output, inputs)
	if ctx.Err() != nil {
		return unavailable
	}
	second, err := capture(ctx, owner, time.Now().UTC(), budget)
	if err != nil || first.Fingerprint() != second.Fingerprint() {
		return unavailable
	}
	// Re-evaluate all referenced grants and proof leases using the new snapshot;
	// a stable record digest alone cannot detect a clock-driven expiry or hold.
	latest := &platformComparisonReader{snapshot: second}
	for _, id := range p.PlatformEntryIDs {
		if _, err := h.resolveComparisonEntry(owner, id, latest); err != nil {
			return unavailable
		}
	}
	now := time.Now().UTC()
	for _, deadline := range []time.Time{first.ValidUntil(), second.ValidUntil(), reader.validUntil, latest.validUntil} {
		if !deadline.IsZero() && !now.Before(deadline) {
			return unavailable
		}
	}
	if ctx.Err() != nil {
		return unavailable
	}
	return comparison
}
