package httpapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

type fleetRecord struct {
	Transitions             map[string]controlprotocol.CoreTransition `json:"transitions,omitempty"`
	Batch                   fleet.Batch                               `json:"batch"`
	Deployment              ServerDeployment                          `json:"deployment"`
	Baselines               map[string]*controlprotocol.Identity      `json:"baselines"`
	Enrollments             map[string]Enrollment                     `json:"enrollments"`
	ContinuousAuthorityHash string                                    `json:"continuousAuthorityHash,omitempty"`
	AuthorizationHash       string                                    `json:"authorizationHash"`
	Requests                map[string]string                         `json:"requests"`
}
type preparedFleet struct {
	Policies                map[string]service.EffectivePolicy
	OwnershipWrites         map[string]instanceOwnership
	LiveDeployment          ServerDeployment
	Transitions             map[string]controlprotocol.CoreTransition
	Release                 *controlprotocol.CoreRelease
	Plan                    fleet.Plan
	Deployment              ServerDeployment
	Baselines               map[string]*controlprotocol.Desired
	Enrollments             map[string]Enrollment
	Artifacts               map[string][]domain.Artifact
	Routes                  []domain.PublishedRoute
	Compares                []store.RecordCompare
	Sets                    []store.RecordSetCompare
	ContinuousAuthorityHash string
	AuthorizationHash       string
}

func (h *server) fleetRead(p *preparedFleet, kind, id string, out any, optional bool) error {
	var raw json.RawMessage
	e := h.s.Get(kind, id, &raw)
	if e == store.ErrNotFound && optional {
		p.Compares = append(p.Compares, store.RecordCompare{Kind: kind, ID: id})
		return nil
	}
	if e != nil {
		return e
	}
	p.Compares = append(p.Compares, store.RecordCompare{Kind: kind, ID: id, Expected: raw})
	return json.Unmarshal(raw, out)
}
func (h *server) fleetList(p *preparedFleet, kind string) ([]json.RawMessage, error) {
	all, e := h.s.List(kind)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, raw := range all {
		var id struct {
			ID string `json:"id"`
		}
		if e = json.Unmarshal(raw, &id); e != nil {
			return nil, e
		}
		if id.ID == "" {
			return nil, fmt.Errorf("record identity missing in %s", kind)
		}
		ids = append(ids, id.ID)
		p.Compares = append(p.Compares, store.RecordCompare{Kind: kind, ID: id.ID, Expected: raw})
	}
	p.Sets = append(p.Sets, store.RecordSetCompare{Kind: kind, IDs: ids})
	return all, nil
}
func (h *server) prepareFleet(in fleet.Input) (preparedFleet, error) {
	p := preparedFleet{Policies: map[string]service.EffectivePolicy{}, OwnershipWrites: map[string]instanceOwnership{}, Plan: fleet.Plan{Input: in, Targets: []fleet.Target{}, Supported: true, Diagnostics: []string{}}, Baselines: map[string]*controlprotocol.Desired{}, Enrollments: map[string]Enrollment{}, Artifacts: map[string][]domain.Artifact{}}
	stages, e := fleet.Stages(in)
	if e != nil {
		return p, e
	}
	var live ServerDeployment
	if e = h.fleetRead(&p, "server-deployments", in.DeploymentID, &live, false); e != nil {
		return p, e
	}
	p.LiveDeployment = live
	p.Deployment = live
	if in.Action == "rollback" {
		var source fleetRecord
		if e = h.fleetRead(&p, "fleet-batches", in.SourceBatchID, &source, false); e != nil {
			return p, e
		}
		if source.Deployment.ID != live.ID || source.Batch.Action == "stop" || source.Batch.Action == "install" {
			return p, fmt.Errorf("rollback source must contain configuration for this deployment")
		}
		historical, err := h.fleetView(source)
		if err != nil {
			return p, err
		}
		for _, id := range in.TargetIDs {
			verified := false
			for _, target := range historical.Targets {
				if target.InstanceID == id && target.Status == "succeeded" {
					verified = true
				}
			}
			if !verified {
				return p, fmt.Errorf("rollback source target %s has no verified successful configuration", id)
			}
		}
		// History supplies topology, never historic grants, credentials or policy leases.
		p.Deployment = source.Deployment
		for i := range p.Deployment.IR.Programs {
			p.Deployment.IR.Programs[i].Principals = nil
			for _, current := range live.IR.Programs {
				if current.Instance.ID == p.Deployment.IR.Programs[i].Instance.ID {
					p.Deployment.IR.Programs[i].Principals = append([]domain.ServerPrincipal{}, current.Principals...)
				}
			}
		}
	}
	if in.Action == "install" || in.Action == "upgrade" {
		if in.TargetReleaseID == "" {
			return p, fmt.Errorf("select a targetReleaseId from the official core catalog")
		}
		release, err := controlprotocol.FindInstallableCoreRelease(in.TargetReleaseID)
		if err != nil {
			return p, err
		}
		p.Release = &release
		p.Transitions = map[string]controlprotocol.CoreTransition{}
		// Clone before overlaying a candidate; never alter live draft state while planning.
		raw, _ := json.Marshal(p.Deployment)
		var candidate ServerDeployment
		json.Unmarshal(raw, &candidate)
		p.Deployment = candidate
		for i := range p.Deployment.IR.Programs {
			for _, id := range in.TargetIDs {
				if p.Deployment.IR.Programs[i].Instance.ID == id {
					if p.Deployment.IR.Programs[i].Instance.AdapterID != release.AdapterID {
						return p, fmt.Errorf("release adapter differs from target; cross-adapter migration requires an explicit reviewed configuration conversion")
					}
					p.Deployment.IR.Programs[i].Instance.Version = release.Version
				}
			}
		}
	}
	if in.Action != "stop" {
		for _, program := range p.Deployment.IR.Programs {
			for _, id := range in.TargetIDs {
				if program.Instance.ID == id && controlprotocol.CoreActivationWithdrawn(program.Instance.AdapterID, program.Instance.Version) {
					return p, controlprotocol.ErrCoreReleaseRetired
				}
			}
		}
	}
	allRoutes, e := h.fleetList(&p, "published-routes")
	if e != nil {
		return p, e
	}
	for _, raw := range allRoutes {
		var route domain.PublishedRoute
		if e = json.Unmarshal(raw, &route); e != nil {
			return p, e
		}
		if route.DeploymentID == in.DeploymentID {
			p.Routes = append(p.Routes, route)
		}
	}
	authStart := len(p.Compares)
	if in.Action != "stop" {
		if e = h.refreshFleetPrincipals(&p); e != nil {
			return p, e
		}
	}
	p.AuthorizationHash = fleet.Fingerprint(p.Compares[authStart:])
	p.ContinuousAuthorityHash, e = continuousAuthorityFingerprint(p.Compares[authStart:], p.Policies)
	if e != nil {
		return p, e
	}
	allArtifacts := []domain.Artifact{}
	if in.Action != "stop" {
		allArtifacts, e = render.DefaultServers().Render(p.Deployment.IR)
		if e != nil {
			return p, e
		}
		if e = h.verifyServerTLSArtifacts(p.Deployment.IR, allArtifacts); e != nil {
			return p, e
		}
	}
	now := time.Now().UTC()
	allUsers := map[string]bool{}
	users, e := h.fleetList(&p, "users")
	if e != nil {
		return p, e
	}
	impacted := map[string]map[string]bool{}
	for _, raw := range users {
		var user domain.User
		if e = json.Unmarshal(raw, &user); e != nil {
			return p, e
		}
		overview, e := h.overview(user.ID, now)
		if e != nil {
			return p, e
		}
		for _, r := range overview.Routes {
			if impacted[r.ID] == nil {
				impacted[r.ID] = map[string]bool{}
			}
			impacted[r.ID][user.ID] = true
		}
	}
	for _, id := range in.TargetIDs {
		var program *domain.ServerProgram
		for i := range p.Deployment.IR.Programs {
			if p.Deployment.IR.Programs[i].Instance.ID == id {
				program = &p.Deployment.IR.Programs[i]
				break
			}
		}
		if program == nil {
			return p, fmt.Errorf("target %s is absent from deployment", id)
		}
		target := fleet.Target{InstanceID: id, NodeID: program.Instance.HostID, Name: program.Instance.Name, AdapterID: program.Instance.AdapterID, CoreVersion: program.Instance.Version, Stage: stages[id], Supported: true, Status: "planned", AffectedRouteIDs: []string{}, Changes: []string{}, Diagnostics: []string{}, Attempts: []fleet.Attempt{}}
		var instance domain.CoreInstance
		var endpoint domain.ManagedEndpoint
		if e = h.fleetRead(&p, "core-instances", id, &instance, false); e != nil {
			return p, e
		}
		var host domain.Host
		if e = h.fleetRead(&p, "hosts", instance.HostID, &host, false); e != nil {
			return p, e
		}
		if in.Action == "stop" {
			program.Instance = instance
			target.NodeID = instance.HostID
			target.Name = instance.Name
			target.AdapterID = instance.AdapterID
			target.CoreVersion = instance.Version
		}
		registered := instance
		if p.Release != nil {
			registered.Version = p.Release.Version
		}
		if registered != program.Instance {
			return p, fmt.Errorf("target %s no longer matches registered instance; review inventory before rollout", id)
		}
		if e = h.fleetRead(&p, "managed-endpoints", program.Listener.ID, &endpoint, in.Action == "stop"); e != nil {
			return p, e
		}
		if in.Action != "stop" && !reflect.DeepEqual(endpoint, program.Listener) {
			return p, fmt.Errorf("target %s listener differs from registered inventory", id)
		}
		var enrollment Enrollment
		if e = h.fleetRead(&p, "instance-enrollments", id, &enrollment, true); e != nil {
			return p, e
		}
		p.Enrollments[id] = enrollment
		if enrollment.Revoked || enrollment.Scope.InstanceID != id || enrollment.Scope.NodeID != instance.HostID || !now.Before(enrollment.ExpiresAt) {
			target.Supported = false
			target.Diagnostics = append(target.Diagnostics, "Active scoped enrollment required")
		}
		var old controlprotocol.Desired
		if e = h.fleetRead(&p, "agent-desired", id, &old, true); e != nil {
			return p, e
		}
		ownership, err := h.prepareInstanceOwnership(&p, id, in.DeploymentID, in.Action)
		if err != nil {
			return p, err
		}
		p.OwnershipWrites[id] = ownership
		if old.Generation > 0 {
			copy := old
			p.Baselines[id] = &copy
		}
		if in.Action != "stop" && p.Release == nil && old.Generation > 0 && (old.AdapterID != instance.AdapterID || old.CoreVersion != instance.Version) {
			target.Supported = false
			target.Diagnostics = append(target.Diagnostics, "Adapter/version migration requires the verified upgrade procedure")
		}
		parts := []domain.Artifact{}
		for _, a := range allArtifacts {
			if strings.HasPrefix(a.Path, id+"/") {
				parts = append(parts, domain.Artifact{Path: strings.TrimPrefix(a.Path, id+"/"), Content: a.Content})
			}
		}
		if in.Action == "stop" {
			if old.Generation == 0 {
				target.Supported = false
				target.Diagnostics = append(target.Diagnostics, "No accepted runtime package exists for this target")
			} else {
				parts = append([]domain.Artifact{}, old.Artifacts...)
				program.Instance.AdapterID = old.AdapterID
				program.Instance.Version = old.CoreVersion
				target.AdapterID = old.AdapterID
				target.CoreVersion = old.CoreVersion
			}
		}
		p.Artifacts[id] = parts
		target.Changes = fleet.ChangedArtifacts(old.Artifacts, parts)
		target.ConfigDiff = fleetConfigDiff(old.Artifacts, parts)
		target.CurrentVersion = old.CoreVersion
		affected := map[string]bool{}
		for _, route := range p.Routes {
			for _, endpointID := range route.EndpointIDs {
				if endpointID == program.Listener.ID {
					target.AffectedRouteIDs = append(target.AffectedRouteIDs, route.ID)
					for user := range impacted[route.ID] {
						affected[user] = true
						allUsers[user] = true
					}
					break
				}
			}
		}
		sort.Strings(target.AffectedRouteIDs)
		target.AffectedUsers = len(affected)
		if in.Action == "upgrade" {
			var state controlprotocol.State
			if e = h.fleetRead(&p, "agent-observations", id, &state, true); e != nil {
				return p, e
			}
			from := fleetTransitionFrom(state, old, enrollment.Scope)
			if from == nil {
				target.Supported = false
				target.Diagnostics = append(target.Diagnostics, "Upgrade requires an exact observed or verified stopped previous runtime identity")
			} else if from.AdapterID == program.Instance.AdapterID && from.CoreVersion == program.Instance.Version {
				target.Supported = false
				target.Diagnostics = append(target.Diagnostics, "The requested version is already the observed version; use configure or start instead")
			} else {
				p.Transitions[id] = controlprotocol.CoreTransition{From: *from, ReleaseID: p.Release.ID, ExecutableSHA256: p.Release.ExecutableSHA256}
				target.CurrentVersion = from.CoreVersion
			}
		}
		p.Plan.Supported = p.Plan.Supported && target.Supported
		p.Plan.Targets = append(p.Plan.Targets, target)
	}
	p.Plan.AffectedUsers = len(allUsers)
	p.Plan.Disruption = "Each selected core restarts; existing connections on that core may close. Later stages wait for successful observations."
	if in.Action == "install" {
		p.Plan.Disruption = "Install and validate the exact official artifact in a private immutable path; do not replace or restart the active runtime."
	}
	if in.Action == "stop" {
		p.Plan.Disruption = "Each selected core stops; all routes using that core become unavailable until an explicitly reviewed start."
	}
	p.Plan.Fingerprint = fleet.Fingerprint(struct {
		Transitions map[string]controlprotocol.CoreTransition
		Input       fleet.Input
		IR          domain.ServerDeploymentIR
		Baselines   map[string]*controlprotocol.Desired
		Enrollments map[string]Enrollment
		Auth        string
		Targets     []fleet.Target
		Routes      []domain.PublishedRoute
	}{p.Transitions, in, p.Deployment.IR, p.Baselines, p.Enrollments, p.AuthorizationHash, p.Plan.Targets, p.Routes})
	return p, nil
}

func (h *server) refreshFleetPrincipals(p *preparedFleet) error {
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

func fleetTransitionFrom(state controlprotocol.State, desired controlprotocol.Desired, scope controlprotocol.Scope) *controlprotocol.Identity {
	if state.Desired == nil || *state.Desired != desired.Identity() || state.RecoveryRequired {
		return nil
	}
	if (state.Phase == controlprotocol.ObservedConformant || state.Phase == controlprotocol.ApplyFailed || state.Phase == controlprotocol.ValidationFailed || state.Phase == "installed") && state.NativeChecked && state.Observed != nil && state.Observed.Known && state.Observed.Quiescent && state.Observed.Scope == scope {
		value := state.Observed.Identity
		return &value
	}
	if state.Observed == nil && state.LastKnownValid != nil && state.LastKnownValid.Scope == scope && (state.Phase == "stopped" || state.Phase == controlprotocol.Blocked && state.Code == "policy_restricted") {
		value := *state.LastKnownValid
		return &value
	}
	return nil
}
