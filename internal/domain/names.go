package domain

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

type NamedIdentity struct{ ID, Name string }

// NameAllocation is persisted per output, not used as endpoint identity.
// Remembering the input label lets a deliberate rename replace an old allocation.
type NameAllocation struct {
	DisplayName string `json:"displayName"`
	OutputName  string `json:"outputName"`
}

// AllocateNames preserves readable labels. A short deterministic suffix is used
// only for a collision or reserved native name. Previous allocations freeze the
// choices across additions/removals, while explicit display renames reallocate.
func AllocateNames(items []NamedIdentity, previous map[string]NameAllocation, reserved ...string) (map[string]NameAllocation, error) {
	ordered := append([]NamedIdentity{}, items...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	ids := map[string]bool{}
	for i := range ordered {
		ordered[i].Name = strings.TrimSpace(ordered[i].Name)
		item := ordered[i]
		if !ValidID(item.ID) || ids[item.ID] || !validOutputName(item.Name, 160) {
			return nil, fmt.Errorf("invalid or duplicate output identity/name")
		}
		ids[item.ID] = true
	}
	used := map[string]bool{}
	for _, name := range reserved {
		used[name] = true
	}
	out := map[string]NameAllocation{}
	for _, item := range ordered {
		old, ok := previous[item.ID]
		if ok && old.DisplayName == item.Name && validOutputName(old.OutputName, 240) && !used[old.OutputName] {
			out[item.ID] = old
			used[old.OutputName] = true
		}
	}
	for _, item := range ordered {
		if _, ok := out[item.ID]; ok {
			continue
		}
		name := item.Name
		if used[name] {
			hash := fmt.Sprintf("%x", sha256.Sum256([]byte(item.ID)))
			for size := 6; ; size += 2 {
				name = item.Name + " · " + hash[:size]
				if !used[name] {
					break
				}
				if size == 64 {
					return nil, fmt.Errorf("output name allocation collision")
				}
			}
		}
		out[item.ID] = NameAllocation{DisplayName: item.Name, OutputName: name}
		used[name] = true
	}
	return out, nil
}
func StableNames(items []NamedIdentity) (map[string]string, error) {
	allocation, err := AllocateNames(items, nil)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for id, a := range allocation {
		out[id] = a.OutputName
	}
	return out, nil
}
func validOutputName(s string, max int) bool {
	if strings.TrimSpace(s) == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
