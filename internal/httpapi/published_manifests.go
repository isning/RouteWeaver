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

func (h *server) probeAppliedPublishedManifest(routeID, instanceID string) (domain.PublishedManifest, error) {
	var manifest domain.PublishedManifest
	var state controlprotocol.State
	if e := h.s.Get("agent-observations", instanceID, &state); e != nil {
		if errors.Is(e, store.ErrNotFound) {
			return manifest, errPublishedProofUnconfirmed
		}
		return manifest, e
	}
	if state.Phase != controlprotocol.ObservedConformant || !state.NativeChecked || state.RecoveryRequired || state.Observed == nil || !state.Observed.Known || !state.Observed.Quiescent {
		return manifest, errPublishedProofUnconfirmed
	}
	if e := h.s.Get("published-manifests", state.Observed.RevisionID, &manifest); e != nil {
		return manifest, e
	}
	raw, _ := json.Marshal(state.Observed.Identity)
	var identity domain.DeploymentIdentity
	if e := json.Unmarshal(raw, &identity); e != nil {
		return manifest, e
	}
	if manifest.Identity != identity {
		return manifest, fmt.Errorf("published principal manifest does not match applied identity")
	}
	if !time.Now().Before(manifest.PolicyExpiresAt) {
		return manifest, errPublishedProofUnconfirmed
	}
	var enrollment Enrollment
	if e := h.s.Get("instance-enrollments", instanceID, &enrollment); e != nil {
		return manifest, e
	}
	if enrollment.Revoked || !time.Now().Before(enrollment.ExpiresAt) {
		return manifest, errPublishedProofUnconfirmed
	}
	if enrollment.Scope != state.Observed.Scope {
		return manifest, fmt.Errorf("published entry enrollment does not match observed identity")
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
			return manifest, fmt.Errorf("published route manifest identity is inconsistent")
		}
		found = true
	}
	if !found {
		return manifest, errPublishedProofUnconfirmed
	}
	return manifest, nil
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
}

func (h *server) appliedPublishedPathBundle(routeID string) (appliedPathBundle, error) {
	resolved, err := h.probeAppliedPublishedPathBundle(routeID)
	if err != nil {
		return appliedPathBundle{}, fmt.Errorf("published path is not fully applied")
	}
	return resolved, nil
}

func (h *server) probeAppliedPublishedPathBundle(routeID string) (appliedPathBundle, error) {
	records, e := h.s.List("agent-observations")
	if e != nil {
		return appliedPathBundle{}, e
	}
	manifests := map[string]domain.PublishedManifest{}
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
		manifest, e := h.probeAppliedPublishedManifest(routeID, state.Observed.InstanceID)
		if e == nil {
			manifests[manifest.Program.Listener.ID] = manifest
		} else if !errors.Is(e, errPublishedProofUnconfirmed) && unexpected == nil {
			unexpected = e
		}
	}
	for _, manifest := range manifests {
		for _, route := range manifest.Routes {
			if route.ID != routeID || route.Path.Entry != manifest.Program.Listener.ID {
				continue
			}
			complete := true
			programs := make([]domain.ServerProgram, 0, len(route.EndpointIDs))
			for _, id := range route.EndpointIDs {
				hop, ok := manifests[id]
				if !ok || hop.DeploymentID != manifest.DeploymentID || hop.Fingerprint != manifest.Fingerprint {
					complete = false
					break
				}
				programs = append(programs, hop.Program)
			}
			if complete {
				return appliedPathBundle{Entry: manifest, Programs: programs}, nil
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
