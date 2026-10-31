// Package reuse owns versioned template intent and deterministic personal override
// precedence. It does not fetch resources, persist records, or render clients.
package reuse

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
)

// MergeSteps performs a three-way, stable-identity merge. A personal change or
// deletion wins over upstream. Personal ordering wins when the relative order of
// surviving baseline items changes; upstream-only additions append in that case.
func MergeSteps(base, local, next []domain.ProcessingStep) ([]domain.ProcessingStep, []string) {
	return mergeItems(base, local, next, func(s domain.ProcessingStep) string { return s.ID }, "steps")
}

// MergeProfile only merges the reusable policy/runtime slice. Connection
// credentials, source bindings, names, resources and identity remain local.
func MergeProfile(base, local, next domain.ClientProfileIR) (domain.ClientProfileIR, []string) {
	out := clone(local)
	var kept, more []string
	out.Groups, kept = mergeItems(base.Groups, local.Groups, next.Groups, func(g domain.PolicyGroup) string { return g.ID }, "groups")
	out.Rules, more = mergeItems(base.Rules, local.Rules, next.Rules, func(r domain.PolicyRule) string { return r.ID }, "rules")
	kept = append(kept, more...)
	if reflect.DeepEqual(base.DefaultAction, local.DefaultAction) {
		out.DefaultAction = clone(next.DefaultAction)
	} else {
		kept = append(kept, "defaultAction")
	}
	// Runtime fields are independently owned, so changing one's listener port does
	// not prevent an upstream DNS improvement from being previewed.
	if base.Runtime.MixedPort == local.Runtime.MixedPort {
		out.Runtime.MixedPort = next.Runtime.MixedPort
	} else {
		kept = append(kept, "runtime.mixedPort")
	}
	if base.Runtime.Sniff == local.Runtime.Sniff {
		out.Runtime.Sniff = next.Runtime.Sniff
	} else {
		kept = append(kept, "runtime.sniff")
	}
	if reflect.DeepEqual(base.Runtime.DNS, local.Runtime.DNS) {
		out.Runtime.DNS = clone(next.Runtime.DNS)
	} else {
		kept = append(kept, "runtime.dns")
	}
	if reflect.DeepEqual(base.Runtime.TUN, local.Runtime.TUN) {
		out.Runtime.TUN = clone(next.Runtime.TUN)
	} else {
		kept = append(kept, "runtime.tun")
	}
	return out, kept
}

// AdoptProfile applies a template to a profile without overwriting existing
// personal policy items. Runtime/default action are explicit template selection
// values; subsequent updates use the three-way precedence above.
func AdoptProfile(local, template domain.ClientProfileIR) (domain.ClientProfileIR, []string) {
	out, kept := MergeProfile(domain.ClientProfileIR{}, local, template)
	out.Runtime = clone(template.Runtime)
	out.DefaultAction = template.DefaultAction
	filtered := kept[:0]
	for _, k := range kept {
		if k != "defaultAction" && k != "runtime.mixedPort" && k != "runtime.sniff" && k != "runtime.dns" && k != "runtime.tun" {
			filtered = append(filtered, k)
		}
	}
	return out, filtered
}

func mergeItems[T any](base, local, next []T, id func(T) string, path string) ([]T, []string) {
	b, l, n := map[string]T{}, map[string]T{}, map[string]T{}
	for _, v := range base {
		b[id(v)] = v
	}
	for _, v := range local {
		l[id(v)] = v
	}
	for _, v := range next {
		n[id(v)] = v
	}
	chosen := map[string]T{}
	kept := []string{}
	for _, v := range next {
		k := id(v)
		old, was := b[k]
		own, has := l[k]
		if was && !has {
			kept = append(kept, path+"/"+k+" (deleted)")
			continue
		}
		if has && (!was || !reflect.DeepEqual(old, own)) {
			chosen[k] = own
			kept = append(kept, path+"/"+k)
		} else {
			chosen[k] = v
		}
	}
	for _, v := range local {
		k := id(v)
		if _, exists := n[k]; exists {
			continue
		}
		old, was := b[k]
		if !was || !reflect.DeepEqual(old, v) {
			chosen[k] = v
			kept = append(kept, path+"/"+k)
		}
	}
	// Any personal membership or ordering edit is an explicit order override.
	localOrder := []string{}
	baseOrder := []string{}
	for _, v := range local {
		localOrder = append(localOrder, id(v))
	}
	for _, v := range base {
		baseOrder = append(baseOrder, id(v))
	}
	ordered := next
	if !reflect.DeepEqual(localOrder, baseOrder) {
		ordered = local
	}
	out := []T{}
	seen := map[string]bool{}
	appendChosen := func(list []T) {
		for _, v := range list {
			k := id(v)
			if value, ok := chosen[k]; ok && !seen[k] {
				out = append(out, clone(value))
				seen[k] = true
			}
		}
	}
	appendChosen(ordered)
	appendChosen(next)
	appendChosen(local)
	return out, kept
}

func clone[T any](v T) T { b, _ := json.Marshal(v); var out T; _ = json.Unmarshal(b, &out); return out }
