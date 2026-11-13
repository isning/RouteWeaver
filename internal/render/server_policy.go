package render

import (
	"fmt"
	"routeweaver/internal/domain"
	"strings"
)

// normalizeServerProgram adapts the earlier ordered egress contract into named
// connectors, then validates policy in server scope, never via ClientProfileIR.
func normalizeServerProgram(p domain.ServerProgram) (domain.ServerProgram, error) {
	if len(p.Egress) > 0 && len(p.Connectors) > 0 {
		return p, fmt.Errorf("choose named connectors or legacy ordered egress, not both")
	}
	legacy := len(p.Egress) > 0
	if legacy {
		p.Connectors = make([]domain.ServerConnector, len(p.Egress))
		for i, c := range p.Egress {
			id := fmt.Sprintf("egress-%d", i+1)
			via := ""
			if i > 0 {
				via = fmt.Sprintf("egress-%d", i)
			}
			p.Connectors[i] = domain.ServerConnector{ID: id, Connection: c, Via: via}
		}
		p.Egress = nil
	}
	connectors := map[string]domain.ServerConnector{}
	for _, c := range p.Connectors {
		if !domain.ValidID(c.ID) || c.ID == "rw-direct" || c.ID == "rw-reject" || connectors[c.ID].ID != "" {
			return p, fmt.Errorf("connector identity invalid, reserved or duplicated")
		}
		connectors[c.ID] = c
	}
	state := map[string]int{}
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("connector cycle at %s", id)
		}
		if state[id] == 2 {
			return nil
		}
		c, ok := connectors[id]
		if !ok {
			return fmt.Errorf("connector reference missing")
		}
		state[id] = 1
		if c.Via != "" {
			if err := visit(c.Via); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for _, c := range p.Connectors {
		if err := visit(c.ID); err != nil {
			return p, err
		}
	}
	if p.DefaultAction.Kind == "" {
		if !legacy && len(p.Connectors) > 0 {
			return p, fmt.Errorf("named connectors require an explicit default action")
		}
		p.DefaultAction = domain.ActionRef{Kind: "direct"}
		if legacy {
			p.DefaultAction = domain.ActionRef{Kind: "forward", Ref: p.Connectors[len(p.Connectors)-1].ID}
		}
	}
	action := func(a domain.ActionRef) error {
		switch a.Kind {
		case "forward":
			if connectors[a.Ref].ID == "" {
				return fmt.Errorf("forward action references missing connector")
			}
		case "direct", "reject":
			if a.Ref != "" {
				return fmt.Errorf("built-in action cannot have reference")
			}
		default:
			return fmt.Errorf("unsupported server action")
		}
		return nil
	}
	for _, principal := range p.Principals {
		if err := action(principal.Action); err != nil {
			return p, fmt.Errorf("principal action: %w", err)
		}
	}
	if err := action(p.DefaultAction); err != nil {
		return p, err
	}
	resources := map[string]bool{}
	for i, r := range p.Resources {
		if !domain.ValidID(r.ID) || resources[r.ID] {
			return p, fmt.Errorf("resources[%d]: invalid or duplicate identity", i)
		}
		resources[r.ID] = true
		if r.OwnerID != "" {
			return p, fmt.Errorf("resources[%d]: private client resources are not administrator server policy", i)
		}
		if err := domain.ValidateRuleResource(r); err != nil {
			return p, fmt.Errorf("resources[%d]: %w", i, err)
		}
	}
	ids := map[string]bool{}
	for i, r := range p.Rules {
		if !domain.ValidID(r.ID) || ids[r.ID] {
			return p, fmt.Errorf("rules[%d]: invalid or duplicate rule identity", i)
		}
		ids[r.ID] = true
		if err := domain.ValidateMatch(r.Match, p.Resources); err != nil {
			return p, fmt.Errorf("rules[%d]: %w", i, err)
		}
		if err := action(r.Action); err != nil {
			return p, fmt.Errorf("rules[%d]: %w", i, err)
		}
	}
	return p, nil
}
func connectorNames(p domain.ServerProgram) map[string]string {
	out := map[string]string{}
	for _, c := range p.Connectors {
		out[c.ID] = c.ID
	}
	return out
}
func xrayPolicyMatch(m domain.MatchExpression) (map[string]any, error) {
	switch m.Op {
	case "domain":
		return map[string]any{"domain": []string{"full:" + m.Value}}, nil
	case "domain-suffix":
		return map[string]any{"domain": []string{"domain:" + m.Value}}, nil
	case "ip-cidr":
		return map[string]any{"ip": []string{m.Value}}, nil
	default:
		return nil, fmt.Errorf("XRAY_RULE_SEMANTICS_UNSUPPORTED: this match has no proven server mapping")
	}
}
func singboxRuleSets(resources []domain.RuleResource) ([]any, bool, error) {
	sets := []any{}
	remote := false
	for i, r := range resources {
		if r.Format != "sing-box-source" && r.Format != "srs" {
			return nil, false, fmt.Errorf("RULE_FORMAT_UNSUPPORTED: resources[%d] requires sing-box source or SRS file", i)
		}
		if r.FormatVersion < 1 || r.FormatVersion > 5 {
			return nil, false, fmt.Errorf("RULE_FORMAT_VERSION_UNSUPPORTED: resources[%d]", i)
		}
		format := "source"
		if r.Format == "srs" {
			format = "binary"
		}
		set := map[string]any{"type": r.Location, "tag": r.ID, "format": format}
		if r.Location == "local" {
			set["path"] = r.Path
		} else {
			remote = true
			set["url"] = r.URL
			set["update_interval"] = fmt.Sprintf("%ds", r.IntervalSeconds)
			set["http_client"] = map[string]any{"engine": "go", "detour": "rw-direct"}
		}
		sets = append(sets, set)
	}
	return sets, remote, nil
}

// These protocols currently have only direct-connection validation. Reject both
// sides of a detour rather than implying unverified chain support.
func validateDirectTLSConnectors(p domain.ServerProgram) error {
	for _, c := range p.Egress {
		if (c.Protocol == "hysteria2" || c.Protocol == "anytls") && len(p.Egress) > 1 {
			return fmt.Errorf("%s_DETOUR_UNSUPPORTED: protocol must connect directly", strings.ToUpper(c.Protocol))
		}
	}
	byID := map[string]domain.Connection{}
	for _, c := range p.Connectors {
		byID[c.ID] = c.Connection
	}
	for _, c := range p.Connectors {
		if c.Via != "" && (c.Connection.Protocol == "hysteria2" || byID[c.Via].Protocol == "hysteria2" || c.Connection.Protocol == "anytls" || byID[c.Via].Protocol == "anytls") {
			protocol := c.Connection.Protocol
			if protocol != "hysteria2" && protocol != "anytls" {
				protocol = byID[c.Via].Protocol
			}
			return fmt.Errorf("%s_DETOUR_UNSUPPORTED: protocol must connect directly", strings.ToUpper(protocol))
		}
	}
	return nil
}
