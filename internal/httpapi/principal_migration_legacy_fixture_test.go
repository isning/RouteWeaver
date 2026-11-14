package httpapi

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"time"
)

// Frozen legacy refresh implementation from routeweaver-fetch-history HEAD
// 68cbef565d728d6c562c3e876bf74b75be0d83b9. Only the function name differs.
// Do not delegate to the current refresh implementation: this is the upgrade oracle.
func (h *server) legacyRefreshFleetPrincipals68cbef5(p *preparedFleet) error {
	for i := range p.Deployment.IR.Programs {
		program := &p.Deployment.IR.Programs[i]
		accepted := []domain.ServerPrincipal{}
		for _, principal := range program.Principals {
			// Rebuild from the currently eligible grant. A removed/revoked/replaced
			// historical principal is excluded, never revived by a configuration rollback.
			entries, e := h.fleetList(p, store.TenantKind(principal.AccountID, "platform-entries"))
			if e != nil {
				return e
			}
			var grant *PublicEntryGrant
			for _, raw := range entries {
				var v PublicEntryGrant
				if e = json.Unmarshal(raw, &v); e != nil {
					return e
				}
				if v.SubjectID == principal.SubjectID && v.CredentialVersion == principal.CredentialVersion && !v.Revoked {
					vCopy := v
					grant = &vCopy
				}
			}
			if grant == nil {
				continue
			}
			var user domain.User
			if e = h.fleetRead(p, "users", principal.AccountID, &user, false); e != nil {
				return e
			}
			var account store.Account
			if e = h.fleetRead(p, "accounts", principal.AccountID, &account, true); e != nil {
				return e
			}
			var entitlement json.RawMessage
			if e = h.fleetRead(p, "entitlements", principal.AccountID, &entitlement, true); e != nil {
				return e
			}
			overview, e := h.overview(principal.AccountID, time.Now().UTC())
			if e != nil {
				return e
			}
			if overview.Service != nil {
				var raw json.RawMessage
				if e = h.fleetRead(p, "services", overview.Service.ID, &raw, false); e != nil {
					return e
				}
			}
			allowed := false
			for _, r := range overview.Routes {
				allowed = allowed || r.ID == principal.RouteID
			}
			if overview.Status != "active" || !allowed {
				continue
			}
			var route *domain.PublishedRoute
			for n := range p.Routes {
				if p.Routes[n].ID == principal.RouteID {
					route = &p.Routes[n]
				}
			}
			if route == nil || grant.UserID != principal.AccountID || grant.DeploymentID != p.Deployment.ID {
				return fmt.Errorf("principal has no current published route grant")
			}
			endpoints := []domain.ManagedEndpoint{}
			for _, id := range route.EndpointIDs {
				for _, pr := range p.Deployment.IR.Programs {
					if pr.Listener.ID == id {
						endpoints = append(endpoints, pr.Listener)
					}
				}
			}
			if len(endpoints) != len(route.EndpointIDs) {
				return fmt.Errorf("historic configuration no longer contains the authorized published route")
			}
			action, e := h.publishedPathAction(p.Deployment.IR, *route, endpoints)
			if e != nil {
				return e
			}
			principal.Action = action
			connection, e := domain.PublicPrincipalConnection(*route, program.Listener, principal)
			if e != nil {
				return e
			}
			if connectionDigest(connection) != connectionDigest(grant.Connection) {
				return fmt.Errorf("principal credential no longer matches current grant")
			}
			p.Policies[principal.AccountID] = overview.EffectivePolicy
			accepted = append(accepted, principal)
		}
		program.Principals = accepted
	}
	return nil
}
