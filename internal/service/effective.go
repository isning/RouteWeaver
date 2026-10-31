package service

import (
	"sort"
	"time"
)

// Group is an authorization group, not a host group or inventory tag. Membership
// selects one service. It never adds together quotas or route grants.
type Group struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	ServiceID string   `json:"serviceId"`
	Priority  int      `json:"priority"`
	MemberIDs []string `json:"memberIds"`
}

type PolicyInput struct {
	UserID         string
	Enabled        bool
	QuotaBytes     int64
	Entitlement    Entitlement
	Plans          []Plan
	Groups         []Group
	DirectRouteIDs []string
}

type EffectivePolicy struct {
	UserID          string            `json:"userId"`
	ServiceID       string            `json:"serviceId,omitempty"`
	GroupIDs        []string          `json:"groupIds"`
	RouteIDs        []string          `json:"routeIds"`
	QuotaBytes      int64             `json:"quotaBytes"`
	OnlineIPLimit   int               `json:"onlineIpLimit"`
	ConnectionLimit int               `json:"connectionLimit"`
	EntryRateBPS    int64             `json:"entryRateBps"`
	Status          string            `json:"status"`
	Provenance      map[string]string `json:"provenance"`
	Entitlement     Entitlement       `json:"entitlement"`
	Service         *Plan             `json:"service,omitempty"`
}

func uniqueSorted(ids []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// ResolvePolicy is the single precedence evaluator for reads and enforcement.
// A tie between different services fails closed even if their current limits
// happen to match. Exact individual route overrides replace legacy grants too.
// The account's established cycle is independent of service/group selection.
func ResolvePolicy(in PolicyInput, now time.Time) EffectivePolicy {
	ent := in.Entitlement
	p := EffectivePolicy{UserID: in.UserID, QuotaBytes: in.QuotaBytes, Status: "active", GroupIDs: []string{}, RouteIDs: []string{}, Provenance: map[string]string{"service": "none", "quotaBytes": "account", "routes": "direct", "cycle": "account"}, Entitlement: ent}
	selected := ent.ServiceID
	source := "individual"
	if selected == "" {
		source = "group"
		highest := 0
		found := false
		services := map[string]bool{}
		for _, g := range in.Groups {
			member := false
			for _, id := range g.MemberIDs {
				member = member || id == in.UserID
			}
			if !member {
				continue
			}
			if !found || g.Priority > highest {
				highest = g.Priority
				found = true
				services = map[string]bool{}
				p.GroupIDs = []string{}
			}
			if g.Priority == highest {
				services[g.ServiceID] = true
				p.GroupIDs = append(p.GroupIDs, g.ID)
			}
		}
		if len(services) > 1 {
			p.Status = "ambiguous"
			p.Provenance["service"] = "ambiguous"
			sort.Strings(p.GroupIDs)
			return p
		}
		for id := range services {
			selected = id
		}
	}
	if selected != "" {
		p.ServiceID = selected
		p.Provenance["service"] = source
		for _, plan := range in.Plans {
			if plan.ID == selected {
				copy := plan
				p.Service = &copy
				break
			}
		}
		if p.Service == nil {
			p.Status = "service-missing"
			return p
		}
		p.QuotaBytes = p.Service.QuotaBytes
		p.OnlineIPLimit = p.Service.OnlineIPLimit
		p.ConnectionLimit = p.Service.ConnectionLimit
		p.EntryRateBPS = p.Service.EntryRateBPS
		p.RouteIDs = append(p.RouteIDs, p.Service.RouteIDs...)
		for _, field := range []string{"quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps", "routes"} {
			p.Provenance[field] = "service:" + selected
		}
	}
	p.RouteIDs = append(p.RouteIDs, in.DirectRouteIDs...)
	if len(in.DirectRouteIDs) > 0 && selected != "" {
		p.Provenance["routes"] += "+direct"
	}
	if ent.RouteIDsOverride != nil {
		p.RouteIDs = append([]string{}, (*ent.RouteIDsOverride)...)
		p.Provenance["routes"] = "individual"
	}
	if ent.QuotaOverride != nil {
		p.QuotaBytes = *ent.QuotaOverride
		p.Provenance["quotaBytes"] = "individual"
	}
	if ent.OnlineIPLimitOverride != nil {
		p.OnlineIPLimit = *ent.OnlineIPLimitOverride
		p.Provenance["onlineIpLimit"] = "individual"
	}
	if ent.ConnectionLimitOverride != nil {
		p.ConnectionLimit = *ent.ConnectionLimitOverride
		p.Provenance["connectionLimit"] = "individual"
	}
	if ent.EntryRateBPSOverride != nil {
		p.EntryRateBPS = *ent.EntryRateBPSOverride
		p.Provenance["entryRateBps"] = "individual"
	}
	p.RouteIDs = uniqueSorted(p.RouteIDs)
	sort.Strings(p.GroupIDs)
	if !in.Enabled {
		p.Status = "disabled"
	} else if ent.Paused {
		p.Status = "paused"
	} else if now.Before(ent.StartsAt) {
		p.Status = "not-started"
	} else if ent.ExpiresAt != nil && !now.Before(*ent.ExpiresAt) {
		p.Status = "expired"
	}
	return p
}

func (p EffectivePolicy) AllowsRoute(id string) bool {
	if p.Status != "active" {
		return false
	}
	for _, route := range p.RouteIDs {
		if route == id {
			return true
		}
	}
	return false
}

// PolicyChange changes exactly one policy record. Membership is updated as part
// of its group, so a bulk membership edit has one preview and atomic commit.
type PolicyChange struct {
	Service     *Plan        `json:"service,omitempty"`
	Group       *Group       `json:"group,omitempty"`
	Entitlement *Entitlement `json:"entitlement,omitempty"`
}
type PolicyEffect struct {
	UserID string          `json:"userId"`
	Before EffectivePolicy `json:"before"`
	After  EffectivePolicy `json:"after"`
}
type PolicyPreview struct {
	Revision string                `json:"revision"`
	Affected []PolicyEffect        `json:"affected"`
	Blockers []string              `json:"blockers"`
	Guard    string                `json:"guard,omitempty"`
	Resource *PolicyResourceReview `json:"resource,omitempty"`
}

// Edit context is separate from persisted policy intent. A baseline identifies
// canonical record content, not a write count or an authorization credential.
type PolicyEditPrecondition struct {
	Exists   bool   `json:"exists"`
	Revision string `json:"revision"`
}
type PolicyResourceTarget struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type PolicyEditContext struct {
	Target       PolicyResourceTarget   `json:"target"`
	Record       *PolicyChange          `json:"record"`
	Precondition PolicyEditPrecondition `json:"precondition"`
	References   *PolicyReferenceLabels `json:"references,omitempty"`
	// Entitlement-only read projection; never substitutes for raw row presence.
	Effective *EffectivePolicy `json:"effective,omitempty"`
}
type PolicyResourceReview struct {
	Target     PolicyResourceTarget      `json:"target"`
	Before     *PolicyChange             `json:"before"`
	After      PolicyChange              `json:"after"`
	References *PolicyResourceReferences `json:"references,omitempty"`
}

// Reference labels are transport-only names observed in the context/preview
// transaction. IDs remain authoritative; absent labels do not remove references.
type PolicyReferenceLabel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type PolicyReferenceLabels struct {
	Users    []PolicyReferenceLabel `json:"users"`
	Services []PolicyReferenceLabel `json:"services"`
}
type PolicyResourceReferences struct {
	Before PolicyReferenceLabels `json:"before"`
	After  PolicyReferenceLabels `json:"after"`
}
