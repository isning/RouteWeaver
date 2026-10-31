package httpapi

import (
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"time"
)

type outputAccessState string

const (
	outputAccessReady       outputAccessState = "ready"
	outputEntryUnconfirmed  outputAccessState = "OUTPUT_ENTRY_UNCONFIRMED"
	outputRepublishRequired outputAccessState = "OUTPUT_REPUBLISH_REQUIRED"
)

var (
	errOutputAccessUnavailable = errors.New("subscription is currently unavailable")
	errOutputAccessUnknown     = errors.New("subscription availability could not be checked")
)

// outputAccessReadiness reports an as-of delivery decision only to the owner.
// It does not publish, rotate, or weaken the feed/bundle's final authorization.
// Authorize every frozen dependency before examining any application proof.
func (h *server) outputAccessReadiness(owner string, output Output) (outputAccessState, error) {
	var account store.Account
	if err := h.s.Get("accounts", owner, &account); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", errOutputAccessUnavailable
		}
		return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, err)
	}
	var user domain.User
	if err := h.s.Get("users", owner, &user); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", errOutputAccessUnavailable
		}
		return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, err)
	}
	if account.ID != owner || account.Disabled || user.ID != owner || !user.Enabled {
		return "", errOutputAccessUnavailable
	}
	if len(output.PlatformDependencies) == 0 {
		return outputAccessReady, nil
	}
	overview, err := h.overview(owner, time.Now())
	if err != nil {
		return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, err)
	}
	if overview.Status != "active" {
		return "", errOutputAccessUnavailable
	}
	allowed := map[string]bool{}
	for _, route := range overview.Routes {
		allowed[route.ID] = true
	}
	grants := make([]PublicEntryGrant, 0, len(output.PlatformDependencies))
	for _, dependency := range output.PlatformDependencies {
		var grant PublicEntryGrant
		if err := h.s.TenantGet(owner, "platform-entries", dependency.ID, &grant); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return "", errOutputAccessUnavailable
			}
			return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, err)
		}
		if grant.ID != dependency.ID || grant.UserID != owner || grant.Revoked || !allowed[grant.RouteID] {
			return "", errOutputAccessUnavailable
		}
		// An entry moving to another route is not a newer credential for the
		// same intended identity. Never suggest republishing that mismatch.
		if grant.RouteID != dependency.RouteID || !domain.ValidID(grant.CredentialVersion) {
			return "", errOutputAccessUnavailable
		}
		if grant.PublishedRouteID != "" {
			if grant.PublishedRouteID != grant.RouteID || !domain.ValidID(grant.SubjectID) || !domain.ValidID(grant.DeploymentID) {
				return "", errOutputAccessUnavailable
			}
		} else {
			// Keep the existing guard against configured legacy credentials
			// impersonating a managed, application-confirmed entry.
			var managed domain.PublishedRoute
			if err := h.s.Get("published-routes", grant.RouteID, &managed); err == nil {
				return "", errOutputAccessUnavailable
			} else if !errors.Is(err, store.ErrNotFound) {
				return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, err)
			}
		}
		grants = append(grants, grant)
	}
	unconfirmed, changed := false, false
	var unexpected error
	for index, grant := range grants {
		connection := grant.Connection
		if grant.PublishedRouteID != "" {
			resolved, err := h.probeEffectivePublishedGrant(grant)
			if err != nil {
				if errors.Is(err, errPublishedProofUnconfirmed) || errors.Is(err, domain.ErrPublishedPrincipalNotInManifest) {
					unconfirmed = true
				} else if unexpected == nil {
					unexpected = err
				}
				continue
			}
			connection = resolved
		}
		dependency := output.PlatformDependencies[index]
		changed = changed || grant.CredentialVersion != dependency.CredentialVersion || connectionDigest(connection) != dependency.ConnectionDigest
	}
	// The order of dependencies cannot turn an unknown/pending entry into
	// permission to update an Output that is not currently deliverable.
	if unexpected != nil {
		return "", fmt.Errorf("%w: %w", errOutputAccessUnknown, unexpected)
	}
	if unconfirmed {
		return outputEntryUnconfirmed, nil
	}
	if changed {
		return outputRepublishRequired, nil
	}
	return outputAccessReady, nil
}

// authorizeOutputDelivery separates account security from platform transport
// entitlement. Private-airport conversion does not consume platform quota.
// A nonnil overview belongs only to an output using frozen platform credentials.
func (h *server) authorizeOutputDelivery(owner string, output Output) (*Overview, error) {
	var account store.Account
	var user domain.User
	if err := h.s.Get("accounts", owner, &account); err != nil || account.ID != owner || account.Disabled {
		return nil, fmt.Errorf("subscription account is unavailable")
	}
	if err := h.s.Get("users", owner, &user); err != nil || user.ID != owner || !user.Enabled {
		return nil, fmt.Errorf("subscription account is unavailable")
	}
	if len(output.PlatformDependencies) == 0 {
		return nil, nil
	}
	overview, err := h.overview(owner, time.Now())
	if err != nil || overview.Status != "active" {
		return nil, fmt.Errorf("platform subscription access inactive")
	}
	for _, dependency := range output.PlatformDependencies {
		entry, err := h.resolveEntry(owner, dependency.ID)
		if err != nil || len(entry.Provenance) != 1 || entry.Provenance[0].SourceID != dependency.RouteID || entry.Provenance[0].SnapshotID != dependency.CredentialVersion || connectionDigest(entry.Connection) != dependency.ConnectionDigest {
			return nil, fmt.Errorf("published platform credentials are no longer eligible; publish an updated subscription")
		}
	}
	return &overview, nil
}
