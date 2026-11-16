package httpapi

import (
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"time"
)

// Attribution comparison is intentionally narrower than selected review. It
// observes saved configuration, not permission to publish or acquire a lease.
func smallAttributionShape(output Output, p Profile) bool {
	if output.Attribution == nil {
		return true
	}
	a := output.Attribution
	if !domain.ValidID(output.ID) || !domain.ValidID(a.Revision) || len(a.Grants) == 0 || len(a.Grants) > 8 || len(a.Grants) != len(p.PlatformEntryIDs) || len(p.SourceIDs) != 0 || p.CollectionID != "" {
		return false
	}
	for _, endpoint := range p.IR.Endpoints {
		if endpoint.Origin != "platform-entry" {
			return false
		}
	}
	originals, isolated := map[string]bool{}, map[string]bool{}
	for _, id := range p.PlatformEntryIDs {
		grant := a.Grants[id]
		if !domain.ValidID(id) || !domain.ValidID(grant) || originals[id] || isolated[grant] {
			return false
		}
		originals[id], isolated[grant] = true, true
	}
	return true
}

func validComparisonAttribution(owner string, output Output, p Profile, snapshot *store.PlatformComparisonSnapshot) bool {
	if output.Attribution == nil {
		return true
	}
	if !smallAttributionShape(output, p) {
		return false
	}
	var intent attributedOutputIntent
	if snapshot.TenantGet(owner, "output-attribution-intents", output.ID, &intent) != nil || intent.ID != output.ID || intent.Owner != owner || intent.Revision != output.Attribution.Revision || intent.State != "published" || intent.Output.ID != output.ID || !reflect.DeepEqual(intent.Output.Attribution, output.Attribution) || len(intent.Plans) != len(output.Attribution.Grants) {
		return false
	}
	seen := map[string]bool{}
	for _, plan := range intent.Plans {
		if seen[plan.OriginalGrantID] || output.Attribution.Grants[plan.OriginalGrantID] != plan.Grant.ID {
			return false
		}
		seen[plan.OriginalGrantID] = true
	}
	return true
}

func (h *server) resolveAttributedComparisonEntry(owner, id string, output Output, reader *platformComparisonReader) (domain.ClientEndpoint, error) {
	unavailable := store.ErrPlatformComparisonUnavailable
	if output.Attribution == nil {
		return domain.ClientEndpoint{}, unavailable
	}
	actual := output.Attribution.Grants[id]
	var grant PublicEntryGrant
	if !domain.ValidID(id) || !domain.ValidID(actual) || reader.snapshot.TenantGet(owner, "platform-entries", actual, &grant) != nil || grant.ID != actual || grant.UserID != owner || grant.Revoked || grant.OutputID != output.ID || grant.OutputRevision != output.Attribution.Revision || grant.PublishedRouteID == "" || grant.PublishedRouteID != grant.RouteID {
		return domain.ClientEndpoint{}, unavailable
	}
	if reader.snapshot.Eligible(grant.RouteID) != nil {
		return domain.ClientEndpoint{}, unavailable
	}
	bundle, err := boundedPublishedPathBundle(reader.snapshot, time.Now, grant.RouteID)
	if err != nil {
		return domain.ClientEndpoint{}, unavailable
	}
	connection, err := connectionForPublishedGrant(grant, bundle.Entry)
	if err != nil {
		return domain.ClientEndpoint{}, unavailable
	}
	// The snapshot's frozen path, not mutable endpoint drafts, determines the
	// exact admitted listener identity. Never check the original shared grant.
	expected := store.EntryAdmissionBinding{ID: grant.SubjectID, InstanceID: bundle.Entry.Program.Instance.ID, EntryID: bundle.Entry.Program.Listener.ID, SubjectID: grant.SubjectID, UserID: owner, RouteID: grant.RouteID, GrantID: actual, CredentialVersion: grant.CredentialVersion, OutputID: output.ID, OutputRevision: output.Attribution.Revision}
	record, err := store.EntryAdmissionBindingRecord(expected)
	if err != nil {
		return domain.ClientEndpoint{}, unavailable
	}
	var binding store.EntryAdmissionBinding
	var claim store.OutputAttributionClaim
	if reader.snapshot.Get(record.Kind, record.ID, &binding) != nil || binding != expected || reader.snapshot.Get("output-attribution-claims", record.ID, &claim) != nil || claim.Binding != binding {
		return domain.ClientEndpoint{}, unavailable
	}
	var intent attributedOutputIntent
	if reader.snapshot.TenantGet(owner, "output-attribution-intents", output.ID, &intent) != nil || intent.ID != output.ID || intent.Owner != owner || intent.State != "published" || intent.Revision != output.Attribution.Revision {
		return domain.ClientEndpoint{}, unavailable
	}
	// Provider evidence is read from the same bounded snapshot as the path.
	// Reuse live policy semantics, without acquiring or settling a lease.
	if len(bundle.Identities) != len(bundle.Programs) {
		return domain.ClientEndpoint{}, unavailable
	}
	entrySeen := false
	for i, identity := range bundle.Identities {
		program := bundle.Programs[i]
		if identity.Generation == 0 || program.Instance.ID != identity.InstanceID || program.Instance.HostID != identity.NodeID || program.Instance.AdapterID != identity.AdapterID || program.Instance.Version != identity.CoreVersion {
			return domain.ClientEndpoint{}, unavailable
		}
		var instance domain.CoreInstance
		if reader.snapshot.Get("core-instances", identity.InstanceID, &instance) != nil || instance.ID != identity.InstanceID || instance.HostID != identity.NodeID {
			return domain.ClientEndpoint{}, unavailable
		}
		if identity.InstanceID == bundle.Entry.Program.Instance.ID {
			if instance.AdapterID != "routeweaver/managed-xray" || program.Listener.ID != bundle.Entry.Program.Listener.ID {
				return domain.ClientEndpoint{}, unavailable
			}
			entrySeen = true
		}
		if instance.AdapterID != identity.AdapterID || instance.Version != identity.CoreVersion {
			return domain.ClientEndpoint{}, unavailable
		}
		var state observability.State
		err := reader.snapshot.Get("node-observability", identity.NodeID, &state)
		if err != nil && err != store.ErrNotFound {
			return domain.ClientEndpoint{}, unavailable
		}
		if err == nil {
			// Persisted counters are nonnegative. Be conservative if storage is
			// damaged rather than letting subtraction invent available quota.
			if state.Config.Provider != nil && state.Config.Provider.ExhaustionAction != "advisory" {
				if state.ObservedNICBytes < 0 || (state.Statement != nil && state.Statement.UsedBytes < 0) || (state.Baseline != nil && (state.Baseline.UsedBytes < 0 || state.Baseline.NICBytesAtBaseline < 0 || state.Baseline.NICBytesAtBaseline > state.ObservedNICBytes)) {
					return domain.ClientEndpoint{}, unavailable
				}
			}
			reason, until := observability.ManagedAdmission(state, time.Now().UTC())
			if reason != "" {
				return domain.ClientEndpoint{}, unavailable
			}
			if until != nil && (reader.validUntil.IsZero() || until.Before(reader.validUntil)) {
				reader.validUntil = *until
			}
		}
	}
	if !entrySeen {
		return domain.ClientEndpoint{}, unavailable
	}
	if reader.validUntil.IsZero() || bundle.ValidUntil.Before(reader.validUntil) {
		reader.validUntil = bundle.ValidUntil
	}
	return domain.ClientEndpoint{ID: id, Name: grant.Name, OwnerID: owner, Origin: "platform-entry", Connection: connection, Provenance: []domain.SourceRef{{SourceID: grant.RouteID, SnapshotID: grant.CredentialVersion, EndpointID: id}}}, nil
}
