package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"time"
)

// Build and validate before queueing; the caller commits the manifest atomically.
func (h *server) preparePublishedManifest(proof *preparedFleet, deployment ServerDeployment, desired controlprotocol.Desired) (domain.PublishedManifest, error) {
	records, e := h.fleetList(proof, "published-routes")
	if e != nil {
		return domain.PublishedManifest{}, e
	}
	routes := []domain.PublishedRoute{}
	for _, raw := range records {
		var route domain.PublishedRoute
		if e = json.Unmarshal(raw, &route); e != nil {
			return domain.PublishedManifest{}, e
		}
		if route.DeploymentID == deployment.ID {
			routes = append(routes, route)
		}
	}
	for _, route := range routes {
		endpoints := []domain.ManagedEndpoint{}
		for _, id := range route.EndpointIDs {
			found := false
			for _, p := range deployment.IR.Programs {
				if p.Listener.ID == id {
					endpoints = append(endpoints, p.Listener)
					found = true
					break
				}
			}
			if !found {
				return domain.PublishedManifest{}, publicationDomainError("A published path endpoint is absent; correct the route and review again.", "published path endpoint is absent from deployment")
			}
		}
		action, err := h.publishedPathActionWithProof(deployment.IR, route, endpoints, proof)
		if err != nil {
			return domain.PublishedManifest{}, err
		}
		for _, p := range deployment.IR.Programs {
			if p.Listener.ID == route.Path.Entry {
				for _, principal := range p.Principals {
					if principal.RouteID == route.ID && principal.Action != action {
						return domain.PublishedManifest{}, publicationDomainError("A published principal differs from its route; correct the route and review again.", "published principal action differs from selected path")
					}
				}
			}
		}
	}
	for _, program := range deployment.IR.Programs {
		if program.Instance.ID == desired.InstanceID {
			identity := domain.DeploymentIdentity{NodeID: desired.NodeID, InstanceID: desired.InstanceID, EnrollmentEpoch: desired.EnrollmentEpoch, AdapterID: desired.AdapterID, CoreVersion: desired.CoreVersion, Generation: desired.Generation, RevisionID: desired.RevisionID, OperationID: desired.OperationID, Digest: desired.Digest}
			manifest := domain.PublishedManifest{PolicyExpiresAt: desired.Lease.ExpiresAt, DeploymentID: deployment.ID, Fingerprint: serverFingerprint(deployment.IR), Identity: identity, Program: program, Routes: routes}
			return manifest, nil
		}
	}
	return domain.PublishedManifest{}, publicationDomainError("The target is absent from the deployment; reload and review again.", "desired target missing from deployment")
}

// This classification is private. Public delivery/reveal callers retain their
// safe unresolved-proof errors rather than exposing storage/decode causes.
var errPublishedProofUnconfirmed = errors.New("published path confirmation is unavailable")

// A caller supplying a snapshot must capture the COMPLETE observation inventory
// successfully before resolving. A partial list can hide duplicate listeners.
// This dependency boundary is not itself a transactional snapshot.
type publishedProofReader interface {
	Get(kind, id string, out any) error
	List(kind string) ([]json.RawMessage, error)
}

func (h *server) probeAppliedPublishedManifest(routeID, instanceID string) (domain.PublishedManifest, error) {
	manifest, _, err := probeAppliedPublishedManifestWithReader(h.s, time.Now, routeID, instanceID)
	return manifest, err
}
func probeAppliedPublishedManifestWithReader(reader publishedProofReader, now func() time.Time, routeID, instanceID string) (domain.PublishedManifest, time.Time, error) {
	var manifest domain.PublishedManifest
	var state controlprotocol.State
	if e := reader.Get("agent-observations", instanceID, &state); e != nil {
		if errors.Is(e, store.ErrNotFound) {
			return manifest, time.Time{}, errPublishedProofUnconfirmed
		}
		return manifest, time.Time{}, e
	}
	if state.Phase != controlprotocol.ObservedConformant || !state.NativeChecked || state.RecoveryRequired || state.Observed == nil || !state.Observed.Known || !state.Observed.Quiescent {
		return manifest, time.Time{}, errPublishedProofUnconfirmed
	}
	if e := reader.Get("published-manifests", state.Observed.RevisionID, &manifest); e != nil {
		return manifest, time.Time{}, e
	}
	raw, _ := json.Marshal(state.Observed.Identity)
	var identity domain.DeploymentIdentity
	if e := json.Unmarshal(raw, &identity); e != nil {
		return manifest, time.Time{}, e
	}
	if manifest.Identity != identity {
		return manifest, time.Time{}, fmt.Errorf("published principal manifest does not match applied identity")
	}
	if !now().Before(manifest.PolicyExpiresAt) {
		return manifest, time.Time{}, errPublishedProofUnconfirmed
	}
	var enrollment Enrollment
	if e := reader.Get("instance-enrollments", instanceID, &enrollment); e != nil {
		return manifest, time.Time{}, e
	}
	if enrollment.Revoked || !now().Before(enrollment.ExpiresAt) {
		return manifest, time.Time{}, errPublishedProofUnconfirmed
	}
	if enrollment.Scope != state.Observed.Scope {
		return manifest, time.Time{}, fmt.Errorf("published entry enrollment does not match observed identity")
	}
	found := false
	for _, route := range manifest.Routes {
		if route.ID != routeID {
			continue
		}
		// Transit manifests also contain this route and need not own its entry.
		// The frozen route's own identities must nevertheless be consistent;
		// corruption is not evidence that an otherwise valid path is pending.
		if route.DeploymentID != manifest.DeploymentID || len(route.EndpointIDs) == 0 || route.Path.Entry != route.EndpointIDs[0] || route.Path.Exit != route.EndpointIDs[len(route.EndpointIDs)-1] {
			return manifest, time.Time{}, fmt.Errorf("published route manifest identity is inconsistent")
		}
		if _, err := domain.ResolvePublishedRouteHops(route); err != nil {
			return manifest, time.Time{}, fmt.Errorf("published route manifest path is inconsistent")
		}
		if found {
			return manifest, time.Time{}, fmt.Errorf("published route manifest identity is duplicated")
		}
		found = true
	}
	if !found {
		return manifest, time.Time{}, errPublishedProofUnconfirmed
	}
	deadline := manifest.PolicyExpiresAt
	if enrollment.ExpiresAt.Before(deadline) {
		deadline = enrollment.ExpiresAt
	}
	return manifest, deadline, nil
}

// appliedPublishedPath resolves only frozen manifest state, not mutable draft
// inventory. A compatible draft does not revoke the last verified path.
func (h *server) appliedPublishedPath(routeID string) (domain.PublishedManifest, error) {
	resolved, err := h.appliedPublishedPathBundle(routeID)
	return resolved.Entry, err
}

// The same verified read supplies both delivery and display metadata. Never
// decorate a confirmed path from mutable inventory or a second resolution.
type appliedPathBundle struct {
	Entry    domain.PublishedManifest
	Programs []domain.ServerProgram
	// ValidUntil is the earliest policy/enrollment deadline on the selected path.
	// It is evidence for revalidation, never a cached authorization.
	ValidUntil time.Time
}

func (h *server) appliedPublishedPathBundle(routeID string) (appliedPathBundle, error) {
	resolved, err := h.probeAppliedPublishedPathBundle(routeID)
	if err != nil {
		return appliedPathBundle{}, fmt.Errorf("published path is not fully applied")
	}
	return resolved, nil
}

func (h *server) probeAppliedPublishedPathBundle(routeID string) (appliedPathBundle, error) {
	// Keep the manual path's existing per-check live clock semantics.
	return probeAppliedPublishedPathBundleWithReader(h.s, time.Now, routeID)
}

// boundedPublishedPathBundle is for a successfully captured complete immutable
// reader only. Recheck real time after all reads; snapshot age cannot extend a
// lease. A consumer that does more work must check ValidUntil again before use.
func boundedPublishedPathBundle(reader publishedProofReader, now func() time.Time, routeID string) (appliedPathBundle, error) {
	bundle, err := probeAppliedPublishedPathBundleUsing(reader, now, routeID, true)
	if err != nil {
		return appliedPathBundle{}, err
	}
	if !now().Before(bundle.ValidUntil) {
		return appliedPathBundle{}, errPublishedProofUnconfirmed
	}
	return bundle, nil
}
func probeAppliedPublishedPathBundleWithReader(reader publishedProofReader, now func() time.Time, routeID string) (appliedPathBundle, error) {
	return probeAppliedPublishedPathBundleUsing(reader, now, routeID, false)
}
func probeAppliedPublishedPathBundleUsing(reader publishedProofReader, now func() time.Time, routeID string, strict bool) (appliedPathBundle, error) {
	records, e := reader.List("agent-observations")
	if e != nil {
		return appliedPathBundle{}, e
	}
	manifests := map[string]domain.PublishedManifest{}
	ambiguous := map[string]bool{}
	deadlines := map[string]time.Time{}
	var unexpected error
	for _, raw := range records {
		var state controlprotocol.State
		if e := json.Unmarshal(raw, &state); e != nil {
			if unexpected == nil {
				unexpected = e
			}
			continue
		}
		if state.Observed == nil {
			continue
		}
		if state.Observed.InstanceID == "" {
			if unexpected == nil {
				unexpected = fmt.Errorf("observed instance identity is missing")
			}
			continue
		}
		manifest, deadline, e := probeAppliedPublishedManifestWithReader(reader, now, routeID, state.Observed.InstanceID)
		if e == nil {
			id := manifest.Program.Listener.ID
			if _, exists := manifests[id]; exists {
				ambiguous[id] = true
			}
			manifests[id] = manifest
			deadlines[id] = deadline
		} else if !errors.Is(e, errPublishedProofUnconfirmed) && unexpected == nil {
			unexpected = e
		}
	}
	// Only the new bounded consumer rejects all unexpected inventory errors.
	// Keep the existing manual resolver's complete-path precedence unchanged.
	if strict && unexpected != nil {
		return appliedPathBundle{}, unexpected
	}
	for _, manifest := range manifests {
		for _, route := range manifest.Routes {
			if route.ID != routeID || route.Path.Entry != manifest.Program.Listener.ID || ambiguous[route.Path.Entry] {
				continue
			}
			complete := true
			deadline := deadlines[manifest.Program.Listener.ID]
			programs := make([]domain.ServerProgram, 0, len(route.EndpointIDs))
			for _, id := range route.EndpointIDs {
				hop, ok := manifests[id]
				if !ok || ambiguous[id] || hop.DeploymentID != manifest.DeploymentID || hop.Fingerprint != manifest.Fingerprint {
					complete = false
					break
				}
				matches := 0
				for _, snapshot := range hop.Routes {
					if snapshot.ID == route.ID && samePublishedRouteSnapshot(route, snapshot) {
						matches++
					}
				}
				if matches != 1 {
					complete = false
					break
				}
				programs = append(programs, hop.Program)
				if deadlines[id].Before(deadline) {
					deadline = deadlines[id]
				}
			}
			if complete {
				return appliedPathBundle{Entry: manifest, Programs: programs, ValidUntil: deadline}, nil
			}
		}
	}
	if unexpected != nil {
		return appliedPathBundle{}, unexpected
	}
	return appliedPathBundle{}, errPublishedProofUnconfirmed
}
func (h *server) effectivePublishedGrant(grant PublicEntryGrant) (domain.Connection, error) {
	manifest, e := h.appliedPublishedPath(grant.PublishedRouteID)
	if e != nil {
		return domain.Connection{}, e
	}
	return connectionForPublishedGrant(grant, manifest)
}

func (h *server) probeEffectivePublishedGrant(grant PublicEntryGrant) (domain.Connection, error) {
	resolved, err := h.probeAppliedPublishedPathBundle(grant.PublishedRouteID)
	if err != nil {
		return domain.Connection{}, err
	}
	return connectionForPublishedGrant(grant, resolved.Entry)
}

func connectionForPublishedGrant(grant PublicEntryGrant, manifest domain.PublishedManifest) (domain.Connection, error) {
	if manifest.DeploymentID != grant.DeploymentID {
		return domain.Connection{}, fmt.Errorf("entry belongs to a different deployment")
	}
	connection, _, e := domain.ResolvePublishedPrincipal(manifest, grant.SubjectID, grant.UserID, grant.RouteID, grant.CredentialVersion)
	if e != nil {
		return domain.Connection{}, e
	}
	if connectionDigest(connection) != connectionDigest(grant.Connection) {
		return domain.Connection{}, fmt.Errorf("grant does not match immutable applied credential")
	}
	return connection, nil
}
