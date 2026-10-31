package httpapi

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

const maxFrozenRoutingIntentBytes = 64 << 10
const maxFrozenRoutingMatchBytes = 8 << 10

// FrozenRoutingIntent belongs to an Output's private publication record. It is
// returned only to its owner in a selected review or published-content detail,
// never by outputView, an access-link response, or the subscription manifest.
// It describes declared policy, not a client's current selection or application.
type FrozenRoutingIntent struct {
	Version int    `json:"version"`
	Kind    string `json:"kind"`
	*FrozenPortableRoutingIntent
}

// Only portable full configurations carry policy fields. In particular, an
// opaque native override must not turn unknown policy into a zero rule count.
type FrozenPortableRoutingIntent struct {
	DefaultAction    *FrozenRoutingAction    `json:"defaultAction,omitempty"`
	RuleCount        int                     `json:"ruleCount"`
	Rules            []FrozenRoutingRule     `json:"rules"`
	OmittedRuleCount int                     `json:"omittedRuleCount"`
	Resources        []FrozenRoutingResource `json:"resources,omitempty"`
}

type FrozenRoutingAction struct {
	Kind  string `json:"kind"`
	Ref   string `json:"ref,omitempty"`
	Label string `json:"label,omitempty"`
}

type FrozenRoutingRule struct {
	ID     string              `json:"id"`
	Match  FrozenRoutingMatch  `json:"match"`
	Action FrozenRoutingAction `json:"action"`
}

type FrozenRoutingMatch struct {
	State      string                  `json:"state"`
	Expression *domain.MatchExpression `json:"expression,omitempty"`
	Reason     string                  `json:"reason,omitempty"`
}

// A resource is identified, not expanded. Its contents, URL and delivery
// credentials are intentionally outside this policy-intent comparison.
type FrozenRoutingResource struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Call only after the same materialized profile has rendered successfully.
// Array order is policy order. Display labels come from that render's retained
// name allocations; stable references remain separate from display names.
func summarizeFrozenRoutingIntent(ir domain.ClientProfileIR, mode render.OutputMode, names map[string]string, budget int) *FrozenRoutingIntent {
	if budget > maxFrozenRoutingIntentBytes {
		budget = maxFrozenRoutingIntentBytes
	}
	intent := &FrozenRoutingIntent{Version: 1, Kind: "portable"}
	if ir.NativeOverride != nil {
		intent.Kind = "native-override"
		return boundedRoutingIntent(intent, budget)
	}
	if mode == render.NodesOnly {
		intent.Kind = "nodes-only"
		return boundedRoutingIntent(intent, budget)
	}
	intent.FrozenPortableRoutingIntent = &FrozenPortableRoutingIntent{Rules: []FrozenRoutingRule{}}
	safeLabel := routingLabelSanitizer(ir.Endpoints)
	action := frozenRoutingAction(ir.DefaultAction, names, safeLabel)
	intent.DefaultAction = &action
	intent.RuleCount = len(ir.Rules)
	intent.OmittedRuleCount = len(ir.Rules)
	for _, resource := range ir.Resources {
		label := resource.Name
		if label == "" {
			label = resource.ID
		}
		intent.Resources = append(intent.Resources, FrozenRoutingResource{ID: resource.ID, Label: safeLabel(label)})
	}
	if boundedRoutingIntent(intent, budget) == nil {
		// At the record-size edge, absence means unavailable detail, never an
		// empty policy. Keep the existing deliverable publishable when possible.
		return nil
	}
	for _, rule := range ir.Rules {
		intent.Rules = append(intent.Rules, FrozenRoutingRule{ID: rule.ID, Match: frozenRoutingMatch(rule.Match, safeLabel), Action: frozenRoutingAction(rule.Action, names, safeLabel)})
		intent.OmittedRuleCount--
		if boundedRoutingIntent(intent, budget) == nil {
			intent.Rules = intent.Rules[:len(intent.Rules)-1]
			intent.OmittedRuleCount++
			break
		}
	}
	return intent
}

func boundedRoutingIntent(intent *FrozenRoutingIntent, budget int) *FrozenRoutingIntent {
	encoded, err := json.Marshal(intent)
	if err != nil || len(encoded) > budget {
		return nil
	}
	return intent
}

func frozenRoutingAction(action domain.ActionRef, names map[string]string, safeLabel func(string) string) FrozenRoutingAction {
	result := FrozenRoutingAction{Kind: action.Kind, Ref: action.Ref}
	if action.Kind == "endpoint" || action.Kind == "group" {
		result.Label = safeLabel(names[action.Ref])
	}
	return result
}

func frozenRoutingMatch(match domain.MatchExpression, safeLabel func(string) string) FrozenRoutingMatch {
	encoded, err := json.Marshal(match)
	if err != nil || len(encoded) > maxFrozenRoutingMatchBytes {
		return FrozenRoutingMatch{State: "omitted", Reason: "size-limit"}
	}
	var safeExpression func(domain.MatchExpression) bool
	safeExpression = func(expression domain.MatchExpression) bool {
		if expression.Value != "" && safeLabel(expression.Value) != expression.Value {
			return false
		}
		for _, child := range expression.Children {
			if !safeExpression(child) {
				return false
			}
		}
		return true
	}
	if !safeExpression(match) {
		// Redacting one leaf would change the predicate's meaning. Withhold the
		// entire match instead, and never call that projection exact or unchanged.
		return FrozenRoutingMatch{State: "omitted", Reason: "sensitive"}
	}
	return FrozenRoutingMatch{State: "exact", Expression: &match}
}

// This supplements artifact/resource-byte equality with declared stable
// identities. Missing or newly enriched display coverage is not a policy edit.
// Resource contents, group members and node settings remain outside this view.
func equalKnownRoutingIntent(a, b *FrozenRoutingIntent) bool {
	if a == nil || b == nil || a.Version != 1 || b.Version != 1 {
		return true
	}
	if a.Kind != b.Kind {
		return false
	}
	if a.Kind != "portable" || a.FrozenPortableRoutingIntent == nil || b.FrozenPortableRoutingIntent == nil {
		return true
	}
	if a.RuleCount != b.RuleCount || a.DefaultAction != nil && b.DefaultAction != nil && !reflect.DeepEqual(a.DefaultAction, b.DefaultAction) {
		return false
	}
	// Bounded snapshots always contain an ordered prefix, not arbitrary samples.
	// Compare only mutually recorded rows; omitted rows are covered by the exact
	// artifact comparison, not inferred empty or changed from missing metadata.
	for i := 0; i < len(a.Rules) && i < len(b.Rules); i++ {
		x, y := a.Rules[i], b.Rules[i]
		if x.ID != y.ID || !reflect.DeepEqual(x.Action, y.Action) {
			return false
		}
		if x.Match.State == "exact" && y.Match.State == "exact" && !reflect.DeepEqual(x.Match.Expression, y.Match.Expression) {
			return false
		}
	}
	return true
}
