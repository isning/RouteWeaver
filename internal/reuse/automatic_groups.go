package reuse

import (
	"crypto/sha256"
	"fmt"
	"routeweaver/internal/domain"
	"sort"
	"strings"
)

// expandAutomaticGroups uses only the materialized, owned endpoint set. No name-based
// geographic inference or unselected source lookup is performed.
func expandAutomaticGroups(p *domain.ClientProfileIR, spec AutomaticGroups) error {
	if len(p.Endpoints) == 0 {
		return fmt.Errorf("automatic groups require at least one selected connection")
	}
	groups := map[string]map[string]bool{}
	names := map[string]string{}
	add := func(key, name, id string) {
		if groups[key] == nil {
			groups[key] = map[string]bool{}
			names[key] = name
		}
		groups[key][id] = true
	}
	for _, endpoint := range p.Endpoints {
		region := strings.TrimSpace(endpoint.Region)
		if region == "" {
			region = "其他地区"
		}
		regionName := "地区 · " + region
		if region == "其他地区" {
			regionName = "其他地区"
		}
		add("region:"+region, regionName, endpoint.ID)
		if len(endpoint.Provenance) == 0 {
			add("source:unattributed", "未标注来源", endpoint.ID)
		}
		for _, source := range endpoint.Provenance {
			if source.SourceID == "" {
				return fmt.Errorf("connection source identity missing")
			}
			name := source.SourceName
			if name == "" {
				name = "未命名来源"
			}
			add("source:"+source.SourceID, "来源 · "+name, endpoint.ID)
		}
	}
	keys := []string{}
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ids := map[string]bool{}
	for _, g := range p.Groups {
		ids[g.ID] = true
	}
	for _, e := range p.Endpoints {
		ids[e.ID] = true
	}
	nameCounts := map[string]int{}
	for _, name := range names {
		nameCounts[name]++
	}
	var regions, all []domain.ActionRef
	generated := []domain.PolicyGroup{}
	for _, key := range keys {
		sum := sha256.Sum256([]byte(key))
		id := fmt.Sprintf("generated-%x", sum[:12])
		if ids[id] {
			return fmt.Errorf("automatic group identity conflicts with an existing connection or group")
		}
		ids[id] = true
		name := names[key]
		if nameCounts[name] > 1 {
			name += fmt.Sprintf(" · %x", sum[:3])
		}
		members := []domain.ActionRef{}
		memberIDs := []string{}
		for endpoint := range groups[key] {
			memberIDs = append(memberIDs, endpoint)
		}
		sort.Strings(memberIDs)
		for _, endpoint := range memberIDs {
			members = append(members, domain.ActionRef{Kind: "endpoint", Ref: endpoint})
		}
		g := domain.PolicyGroup{ID: id, Name: name, Kind: "manual", Members: members}
		if strings.HasPrefix(key, "region:") {
			g.Kind = "url-test"
			g.TestURL = "https://cp.cloudflare.com"
			g.IntervalSeconds = 60
			g.ToleranceMS = 20
			regions = append(regions, domain.ActionRef{Kind: "group", Ref: id})
		}
		all = append(all, domain.ActionRef{Kind: "group", Ref: id})
		generated = append(generated, g)
	}
	appendTo := func(targets []string, members []domain.ActionRef) error {
		for _, id := range targets {
			found := false
			for i := range p.Groups {
				if p.Groups[i].ID == id {
					found = true
					p.Groups[i].Members = append(p.Groups[i].Members, members...)
				}
			}
			if !found {
				return fmt.Errorf("automatic group parent %s does not exist", id)
			}
		}
		return nil
	}
	endpointRefs := []domain.ActionRef{}
	for _, endpoint := range p.Endpoints {
		endpointRefs = append(endpointRefs, domain.ActionRef{Kind: "endpoint", Ref: endpoint.ID})
	}
	sort.Slice(endpointRefs, func(i, j int) bool { return endpointRefs[i].Ref < endpointRefs[j].Ref })
	if err := appendTo(spec.IncludeIn, all); err != nil {
		return err
	}
	if err := appendTo(spec.RegionIncludeIn, regions); err != nil {
		return err
	}
	if err := appendTo(spec.AllEndpointsIn, endpointRefs); err != nil {
		return err
	}
	p.Groups = append(p.Groups, generated...)
	return nil
}
