package httpapi

import (
	"encoding/hex"
	"reflect"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

const maxSemanticChangeRows = 50
const maxSemanticMemberRows = 20
const maxSemanticUseRows = 10

// Private renderer metadata never doubles as a response DTO. This explicit
// owner-review projection carries neither raw settings nor their fingerprints.
type outputSemanticChanges struct {
	Version                      int                                   `json:"version"`
	RenderedConfigurationChanged bool                                  `json:"renderedConfigurationChanged"`
	Groups                       semanticCategory[groupSemanticChange] `json:"groups"`
	Nodes                        semanticCategory[nodeSemanticChange]  `json:"nodes"`
}

type semanticCategory[T any] struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
	*semanticCategoryDetails[T]
}
type semanticCategoryDetails[T any] struct {
	BeforeCount     int `json:"beforeCount"`
	AfterCount      int `json:"afterCount"`
	ChangedCount    int `json:"changedCount"`
	Rows            []T `json:"rows"`
	OmittedRowCount int `json:"omittedRowCount"`
}
type semanticRef struct {
	Kind  string `json:"kind"`
	Ref   string `json:"ref,omitempty"`
	Label string `json:"label,omitempty"`
}
type semanticRuleUse struct {
	ID    string `json:"id"`
	Index int    `json:"index"`
}
type semanticUses struct {
	Scope             string            `json:"scope"`
	State             string            `json:"state"`
	Default           bool              `json:"default"`
	Rules             []semanticRuleUse `json:"rules"`
	Groups            []semanticRef     `json:"groups"`
	OmittedRuleCount  int               `json:"omittedRuleCount"`
	OmittedGroupCount int               `json:"omittedGroupCount"`
}
type groupSemanticValue struct {
	Label       string `json:"label"`
	Selection   string `json:"selection"`
	Strategy    string `json:"strategy,omitempty"`
	MemberCount int    `json:"memberCount"`
}
type groupSemanticChange struct {
	ID                        string              `json:"id"`
	Kind                      string              `json:"kind"`
	Before                    *groupSemanticValue `json:"before,omitempty"`
	After                     *groupSemanticValue `json:"after,omitempty"`
	NameChanged               bool                `json:"nameChanged"`
	StrategyChanged           bool                `json:"strategyChanged"`
	ParametersChanged         bool                `json:"parametersChanged"`
	MembersAdded              []semanticRef       `json:"membersAdded"`
	MembersRemoved            []semanticRef       `json:"membersRemoved"`
	OmittedAddedMemberCount   int                 `json:"omittedAddedMemberCount"`
	OmittedRemovedMemberCount int                 `json:"omittedRemovedMemberCount"`
	MemberOrderChanged        bool                `json:"memberOrderChanged"`
	UsesBefore                semanticUses        `json:"usesBefore"`
	UsesAfter                 semanticUses        `json:"usesAfter"`
}
type nodeSemanticChange struct {
	ID                string       `json:"id"`
	Kind              string       `json:"kind"`
	BeforeLabel       string       `json:"beforeLabel,omitempty"`
	AfterLabel        string       `json:"afterLabel,omitempty"`
	NameChanged       bool         `json:"nameChanged"`
	SettingsChanged   bool         `json:"settingsChanged"`
	ChangedCategories []string     `json:"changedCategories"`
	UsesBefore        semanticUses `json:"usesBefore"`
	UsesAfter         semanticUses `json:"usesAfter"`
}

func unavailableSemantic[T any](reason string) semanticCategory[T] {
	return semanticCategory[T]{State: "unavailable", Reason: reason}
}

// This review is descriptive. It deliberately does not participate in
// equalPublishedContent: identity/provenance edits may emit identical bytes.
func compareOutputSemantics(published Output, candidate preparedOutput) *outputSemanticChanges {
	next := candidate.output
	if published.Mode != render.FullConfig && next.Mode != render.FullConfig {
		return nil
	}
	result := &outputSemanticChanges{Version: 1, RenderedConfigurationChanged: !reflect.DeepEqual(published.Artifacts, next.Artifacts), Groups: unavailableSemantic[groupSemanticChange]("unsupported"), Nodes: unavailableSemantic[nodeSemanticChange]("unsupported")}
	if published.ID != next.ID || published.ProfileID != next.ProfileID || published.Target != next.Target || published.Mode != next.Mode || candidate.result.NativeOverride != nil || !knownPortableOutput(published) || !knownPortableOutput(next) {
		return result
	}
	if published.SemanticSnapshot == nil {
		result.Groups = unavailableSemantic[groupSemanticChange]("baseline-missing")
		result.Nodes = unavailableSemantic[nodeSemanticChange]("baseline-missing")
		return result
	}
	if next.SemanticSnapshot == nil {
		result.Groups = unavailableSemantic[groupSemanticChange]("size-limit")
		result.Nodes = unavailableSemantic[nodeSemanticChange]("size-limit")
		return result
	}
	if !validSemanticSnapshot(published) || !validSemanticSnapshot(next) {
		result.Groups = unavailableSemantic[groupSemanticChange]("invalid-snapshot")
		result.Nodes = unavailableSemantic[nodeSemanticChange]("invalid-snapshot")
		return result
	}
	groupReason, nodeReason := "", ""
	for _, snapshot := range []*render.SemanticSnapshot{published.SemanticSnapshot, next.SemanticSnapshot} {
		if groupReason == "" && snapshot.Groups.State != "available" {
			groupReason = snapshot.Groups.Reason
		}
		if nodeReason == "" && snapshot.Nodes.State != "available" {
			nodeReason = snapshot.Nodes.Reason
		}
	}
	if groupReason != "" {
		result.Groups = unavailableSemantic[groupSemanticChange](groupReason)
	}
	if nodeReason != "" {
		result.Nodes = unavailableSemantic[nodeSemanticChange](nodeReason)
	}
	if groupReason != "" && nodeReason != "" {
		return result
	}
	// Both immutable artifacts supply the private redaction context. A rotated
	// old credential embedded in a new label must be redacted too.
	protected := []domain.ClientEndpoint{}
	for _, output := range []Output{published, next} {
		secrets, err := render.InspectFullConfigSecrets(output.Target, output.Artifacts, output.NameAllocations)
		if err != nil {
			if groupReason == "" {
				result.Groups = unavailableSemantic[groupSemanticChange]("redaction-unavailable")
			}
			if nodeReason == "" {
				result.Nodes = unavailableSemantic[nodeSemanticChange]("redaction-unavailable")
			}
			return result
		}
		for _, secret := range secrets {
			protected = append(protected, domain.ClientEndpoint{Connection: domain.Connection{Password: secret}})
		}
	}
	sanitize := routingLabelSanitizer(protected)
	safeLabel := func(value string) string {
		label := []rune(sanitize(value))
		if len(label) > 240 {
			return string(label[:240]) + "…"
		}
		return string(label)
	}
	if groupReason == "" {
		result.Groups = compareSemanticGroups(published, next, safeLabel)
	}
	if nodeReason == "" {
		result.Nodes = compareSemanticNodes(published, next, safeLabel)
	}
	return result
}

func validSemanticSnapshot(output Output) bool {
	snapshot := output.SemanticSnapshot
	if snapshot == nil || snapshot.Version != 1 {
		return false
	}
	validState := func(state, reason string, count int) bool {
		return state == "available" && reason == "" || state == "unavailable" && count == 0 && (reason == "size-limit" || reason == "unsupported")
	}
	if !validState(snapshot.Groups.State, snapshot.Groups.Reason, len(snapshot.Groups.Items)) || !validState(snapshot.Nodes.State, snapshot.Nodes.Reason, len(snapshot.Nodes.Items)) {
		return false
	}
	seen := map[string]bool{}
	nodes, groups := map[string]bool{}, map[string]bool{}
	for _, node := range snapshot.Nodes.Items {
		if !domain.ValidID(node.ID) || seen[node.ID] || node.Label == "" || output.NameAllocations[node.ID].OutputName != node.Label || !semanticDigest(node.SettingsDigest) {
			return false
		}
		seen[node.ID] = true
		nodes[node.ID] = true
		for _, key := range semanticConnectionCategories[:6] {
			if !semanticDigest(node.CategoryDigests[key]) {
				return false
			}
		}
		for key, value := range node.CategoryDigests {
			if !isSemanticConnectionCategory(key) || !semanticDigest(value) {
				return false
			}
		}
	}
	for _, group := range snapshot.Groups.Items {
		if !domain.ValidID(group.ID) || seen[group.ID] || group.Label == "" || output.NameAllocations[group.ID].OutputName != group.Label || len(group.Members) == 0 || !semanticDigest(group.ParametersDigest) {
			return false
		}
		seen[group.ID] = true
		groups[group.ID] = true
		switch group.Kind {
		case "manual", "url-test", "fallback", "load-balance":
		default:
			return false
		}
		if group.Strategy != "" && group.Strategy != "consistent-hashing" && group.Strategy != "round-robin" && group.Strategy != "sticky-sessions" {
			return false
		}
		if (group.Kind == "load-balance") != (group.Strategy != "") {
			return false
		}
		members := map[domain.ActionRef]bool{}
		for _, member := range group.Members {
			if members[member] {
				return false
			}
			members[member] = true
			if member.Kind == "direct" {
				if member.Ref != "" {
					return false
				}
				continue
			}
			if (member.Kind != "endpoint" && member.Kind != "group") || !domain.ValidID(member.Ref) || output.NameAllocations[member.Ref].OutputName == "" {
				return false
			}
		}
	}
	if snapshot.Groups.State == "available" && snapshot.Nodes.State == "available" && len(seen) != len(output.NameAllocations) {
		return false
	}
	for _, group := range snapshot.Groups.Items {
		for _, member := range group.Members {
			if member.Kind == "group" && snapshot.Groups.State == "available" && !groups[member.Ref] || member.Kind == "endpoint" && snapshot.Nodes.State == "available" && !nodes[member.Ref] {
				return false
			}
		}
	}
	return true
}
func semanticDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && hex.EncodeToString(decoded) == value
}

var semanticConnectionCategories = []string{"endpoint", "protocol", "authentication", "security", "transport", "protocol-options", "other"}

func isSemanticConnectionCategory(value string) bool {
	for _, key := range semanticConnectionCategories {
		if value == key {
			return true
		}
	}
	return false
}

func outputSemanticRef(output Output, ref domain.ActionRef, safe func(string) string) semanticRef {
	value := semanticRef{Kind: ref.Kind, Ref: ref.Ref}
	if ref.Ref != "" {
		value.Label = safe(output.NameAllocations[ref.Ref].OutputName)
	}
	return value
}
func emptySemanticUses() semanticUses {
	return semanticUses{Scope: "direct", State: "available", Rules: []semanticRuleUse{}, Groups: []semanticRef{}}
}
func outputSemanticUses(output Output, ref domain.ActionRef, safe func(string) string) semanticUses {
	uses := emptySemanticUses()
	intent := output.RoutingIntent
	if intent == nil || intent.Version != 1 || intent.Kind != "portable" || intent.FrozenPortableRoutingIntent == nil {
		uses.State = "partial"
	} else {
		if intent.DefaultAction == nil {
			uses.State = "partial"
		} else {
			uses.Default = intent.DefaultAction.Kind == ref.Kind && intent.DefaultAction.Ref == ref.Ref
		}
		if intent.OmittedRuleCount > 0 || intent.RuleCount != len(intent.Rules) {
			uses.State = "partial"
		}
		for index, rule := range intent.Rules {
			if rule.Action.Kind != ref.Kind || rule.Action.Ref != ref.Ref {
				continue
			}
			if len(uses.Rules) < maxSemanticUseRows {
				uses.Rules = append(uses.Rules, semanticRuleUse{ID: rule.ID, Index: index + 1})
			} else {
				uses.OmittedRuleCount++
			}
		}
	}
	if output.SemanticSnapshot == nil || output.SemanticSnapshot.Groups.State != "available" {
		uses.State = "partial"
	} else {
		for _, group := range output.SemanticSnapshot.Groups.Items {
			for _, member := range group.Members {
				if member != ref {
					continue
				}
				if len(uses.Groups) < maxSemanticUseRows {
					uses.Groups = append(uses.Groups, semanticRef{Kind: "group", Ref: group.ID, Label: safe(group.Label)})
				} else {
					uses.OmittedGroupCount++
				}
				break
			}
		}
	}
	if uses.OmittedRuleCount > 0 || uses.OmittedGroupCount > 0 {
		uses.State = "partial"
	}
	return uses
}

func compareSemanticGroups(before, after Output, safe func(string) string) semanticCategory[groupSemanticChange] {
	a, b := before.SemanticSnapshot.Groups, after.SemanticSnapshot.Groups
	if a.State != "available" {
		return unavailableSemantic[groupSemanticChange](a.Reason)
	}
	if b.State != "available" {
		return unavailableSemantic[groupSemanticChange](b.Reason)
	}
	detail := &semanticCategoryDetails[groupSemanticChange]{BeforeCount: len(a.Items), AfterCount: len(b.Items), Rows: []groupSemanticChange{}}
	old, next := map[string]render.SemanticGroup{}, map[string]render.SemanticGroup{}
	for _, item := range a.Items {
		old[item.ID] = item
	}
	for _, item := range b.Items {
		next[item.ID] = item
	}
	add := func(previous, current *render.SemanticGroup) {
		row := groupSemanticChange{Kind: "modified", MembersAdded: []semanticRef{}, MembersRemoved: []semanticRef{}, UsesBefore: emptySemanticUses(), UsesAfter: emptySemanticUses()}
		value := func(group *render.SemanticGroup) *groupSemanticValue {
			if group == nil {
				return nil
			}
			return &groupSemanticValue{Label: safe(group.Label), Selection: group.Kind, Strategy: group.Strategy, MemberCount: len(group.Members)}
		}
		row.Before, row.After = value(previous), value(current)
		oldMembers, newMembers := []domain.ActionRef{}, []domain.ActionRef{}
		if previous != nil {
			row.ID = previous.ID
			oldMembers = previous.Members
			row.UsesBefore = outputSemanticUses(before, domain.ActionRef{Kind: "group", Ref: row.ID}, safe)
		}
		if current != nil {
			row.ID = current.ID
			newMembers = current.Members
			row.UsesAfter = outputSemanticUses(after, domain.ActionRef{Kind: "group", Ref: row.ID}, safe)
		}
		if previous == nil {
			row.Kind = "added"
		} else if current == nil {
			row.Kind = "removed"
		} else {
			row.NameChanged = previous.Label != current.Label
			row.StrategyChanged = previous.Kind != current.Kind || previous.Strategy != current.Strategy
			row.ParametersChanged = previous.ParametersDigest != current.ParametersDigest
		}
		oldSet, newSet := map[domain.ActionRef]bool{}, map[domain.ActionRef]bool{}
		for _, ref := range oldMembers {
			oldSet[ref] = true
		}
		for _, ref := range newMembers {
			newSet[ref] = true
		}
		oldCommon, newCommon := []domain.ActionRef{}, []domain.ActionRef{}
		for _, ref := range oldMembers {
			if newSet[ref] {
				oldCommon = append(oldCommon, ref)
			} else if len(row.MembersRemoved) < maxSemanticMemberRows {
				row.MembersRemoved = append(row.MembersRemoved, outputSemanticRef(before, ref, safe))
			} else {
				row.OmittedRemovedMemberCount++
			}
		}
		for _, ref := range newMembers {
			if oldSet[ref] {
				newCommon = append(newCommon, ref)
			} else if len(row.MembersAdded) < maxSemanticMemberRows {
				row.MembersAdded = append(row.MembersAdded, outputSemanticRef(after, ref, safe))
			} else {
				row.OmittedAddedMemberCount++
			}
		}
		row.MemberOrderChanged = !reflect.DeepEqual(oldCommon, newCommon)
		if previous != nil && current != nil && !row.NameChanged && !row.StrategyChanged && !row.ParametersChanged && len(row.MembersAdded) == 0 && len(row.MembersRemoved) == 0 && row.OmittedAddedMemberCount == 0 && row.OmittedRemovedMemberCount == 0 && !row.MemberOrderChanged {
			return
		}
		detail.ChangedCount++
		if len(detail.Rows) < maxSemanticChangeRows {
			detail.Rows = append(detail.Rows, row)
		} else {
			detail.OmittedRowCount++
		}
	}
	for _, current := range b.Items {
		if previous, ok := old[current.ID]; ok {
			add(&previous, &current)
		} else {
			add(nil, &current)
		}
	}
	for _, previous := range a.Items {
		if _, ok := next[previous.ID]; !ok {
			add(&previous, nil)
		}
	}
	return semanticCategory[groupSemanticChange]{State: "available", semanticCategoryDetails: detail}
}

func compareSemanticNodes(before, after Output, safe func(string) string) semanticCategory[nodeSemanticChange] {
	a, b := before.SemanticSnapshot.Nodes, after.SemanticSnapshot.Nodes
	if a.State != "available" {
		return unavailableSemantic[nodeSemanticChange](a.Reason)
	}
	if b.State != "available" {
		return unavailableSemantic[nodeSemanticChange](b.Reason)
	}
	detail := &semanticCategoryDetails[nodeSemanticChange]{BeforeCount: len(a.Items), AfterCount: len(b.Items), Rows: []nodeSemanticChange{}}
	old, next := map[string]render.SemanticNode{}, map[string]render.SemanticNode{}
	for _, item := range a.Items {
		old[item.ID] = item
	}
	for _, item := range b.Items {
		next[item.ID] = item
	}
	add := func(previous, current *render.SemanticNode) {
		row := nodeSemanticChange{Kind: "modified", ChangedCategories: []string{}, UsesBefore: emptySemanticUses(), UsesAfter: emptySemanticUses()}
		if previous != nil {
			row.ID = previous.ID
			row.BeforeLabel = safe(previous.Label)
			row.UsesBefore = outputSemanticUses(before, domain.ActionRef{Kind: "endpoint", Ref: row.ID}, safe)
		}
		if current != nil {
			row.ID = current.ID
			row.AfterLabel = safe(current.Label)
			row.UsesAfter = outputSemanticUses(after, domain.ActionRef{Kind: "endpoint", Ref: row.ID}, safe)
		}
		if previous == nil {
			row.Kind = "added"
		} else if current == nil {
			row.Kind = "removed"
		} else {
			row.NameChanged = previous.Label != current.Label
			row.SettingsChanged = previous.SettingsDigest != current.SettingsDigest
			if row.SettingsChanged {
				for _, key := range semanticConnectionCategories {
					if previous.CategoryDigests[key] != current.CategoryDigests[key] {
						row.ChangedCategories = append(row.ChangedCategories, key)
					}
				}
				if len(row.ChangedCategories) == 0 {
					row.ChangedCategories = append(row.ChangedCategories, "other")
				}
			}
			if !row.NameChanged && !row.SettingsChanged {
				return
			}
		}
		detail.ChangedCount++
		if len(detail.Rows) < maxSemanticChangeRows {
			detail.Rows = append(detail.Rows, row)
		} else {
			detail.OmittedRowCount++
		}
	}
	for _, current := range b.Items {
		if previous, ok := old[current.ID]; ok {
			add(&previous, &current)
		} else {
			add(nil, &current)
		}
	}
	for _, previous := range a.Items {
		if _, ok := next[previous.ID]; !ok {
			add(&previous, nil)
		}
	}
	return semanticCategory[nodeSemanticChange]{State: "available", semanticCategoryDetails: detail}
}
