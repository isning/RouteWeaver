// Package conversion processes frozen, tenant-owned source snapshots. It never
// fetches URLs, mutates inventory, creates server deployments or logs credentials.
package conversion

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"sort"
	"strings"
)

type Stage struct {
	// Snapshot stages are views, not comparisons against an empty input.
	Comparison string                  `json:"comparison"`
	AddedIDs   []string                `json:"addedIds"`
	Scope      string                  `json:"scope"`
	SourceID   string                  `json:"sourceId,omitempty"`
	StepID     string                  `json:"stepId,omitempty"`
	Endpoints  []domain.ClientEndpoint `json:"endpoints"` // redacted copies only
	RemovedIDs []string                `json:"removedIds"`
	ChangedIDs []string                `json:"changedIds"`
}
type CollectionResult struct {
	Endpoints []domain.ClientEndpoint `json:"endpoints"`
	Stages    []Stage                 `json:"stages"`
}

func ProcessCollection(c domain.Collection, snapshots []domain.SourceSnapshot) (CollectionResult, error) {
	result := CollectionResult{Endpoints: []domain.ClientEndpoint{}, Stages: []Stage{}}
	if !domain.ValidID(c.ID) || !domain.ValidID(c.OwnerID) || strings.TrimSpace(c.Name) == "" {
		return result, fmt.Errorf("collection identity, name and owner required")
	}
	index := map[string]domain.SourceSnapshot{}
	for _, s := range snapshots {
		if _, ok := index[s.SourceID]; ok {
			return result, fmt.Errorf("duplicate source snapshot")
		}
		index[s.SourceID] = s
	}
	selected := map[string]bool{}
	identities := map[string]bool{}
	for i, source := range c.Sources {
		s, ok := index[source.SourceID]
		if !ok || s.OwnerID != c.OwnerID {
			return CollectionResult{}, fmt.Errorf("sources[%d]: source missing or not owned", i)
		}
		if selected[s.SourceID] {
			return CollectionResult{}, fmt.Errorf("sources[%d]: source selected twice", i)
		}
		selected[s.SourceID] = true
		if !domain.ValidID(s.SourceID) || !domain.ValidID(s.SnapshotID) {
			return CollectionResult{}, fmt.Errorf("sources[%d]: invalid snapshot identity", i)
		}
		nodes := clone(s.Endpoints)
		for j := range nodes {
			e := &nodes[j]
			if e.OwnerID != c.OwnerID || e.Origin != "imported" || !domain.ValidID(e.ID) || identities[e.ID] {
				return CollectionResult{}, fmt.Errorf("sources[%d].endpoints[%d]: invalid identity, owner or origin", i, j)
			}
			identities[e.ID] = true
			if err := domain.ValidateConnection(e.Connection); err != nil {
				return CollectionResult{}, fmt.Errorf("sources[%d].endpoints[%d]: %w", i, j, err)
			}
			e.Provenance = appendUniqueProvenance(e.Provenance, domain.SourceRef{SourceID: s.SourceID, SourceName: s.SourceName, SnapshotID: s.SnapshotID, EndpointID: e.ID})
		}
		result.Stages = append(result.Stages, stage("raw", s.SourceID, "", nil, nodes))
		var err error
		nodes, err = applySteps(nodes, source.Steps, "source", s.SourceID, &result.Stages)
		if err != nil {
			return CollectionResult{}, err
		}
		result.Stages = append(result.Stages, stage("source-result", s.SourceID, "", nil, nodes))
		result.Endpoints = append(result.Endpoints, nodes...)
	}
	result.Stages = append(result.Stages, stage("merged", "", "", nil, result.Endpoints))
	var err error
	result.Endpoints, err = applySteps(result.Endpoints, c.Steps, "aggregate", "", &result.Stages)
	if err != nil {
		return CollectionResult{}, err
	}
	return result, nil
}
func applySteps(nodes []domain.ClientEndpoint, steps []domain.ProcessingStep, scope, sourceID string, stages *[]Stage) ([]domain.ClientEndpoint, error) {
	seen := map[string]bool{}
	for i, s := range steps {
		if !domain.ValidID(s.ID) || seen[s.ID] {
			return nil, fmt.Errorf("%s.steps[%d]: invalid or duplicate step identity", scope, i)
		}
		seen[s.ID] = true
		if !s.Enabled {
			continue
		}
		if err := domain.ValidateFilter(s.Filter); err != nil {
			return nil, fmt.Errorf("%s.steps[%d]: %w", scope, i, err)
		}
		before := clone(nodes)
		var err error
		nodes, err = apply(nodes, s)
		if err != nil {
			return nil, fmt.Errorf("%s.steps[%d](%s): %w", scope, i, s.ID, err)
		}
		*stages = append(*stages, stage(scope, sourceID, s.ID, before, nodes))
	}
	return nodes, nil
}
func apply(nodes []domain.ClientEndpoint, s domain.ProcessingStep) ([]domain.ClientEndpoint, error) {
	switch s.Kind {
	case "keep", "drop":
		out := []domain.ClientEndpoint{}
		for _, e := range nodes {
			matches := domain.MatchesEndpoint(e, s.Filter)
			if matches == (s.Kind == "keep") {
				out = append(out, e)
			}
		}
		return out, nil
	case "rename":
		for i := range nodes {
			e := &nodes[i]
			if !domain.MatchesEndpoint(*e, s.Filter) {
				continue
			}
			source := ""
			if len(e.Provenance) > 0 {
				source = e.Provenance[0].SourceName
				if source == "" {
					source = e.Provenance[0].SourceID
				}
			}
			name := strings.NewReplacer("{name}", e.Name, "{region}", e.Region, "{id}", e.ID, "{source}", source).Replace(s.Template)
			if strings.TrimSpace(name) == "" || strings.ContainsAny(name, "{}\r\n") || len(name) > 160 {
				return nil, fmt.Errorf("rename template is empty, too long or has unknown placeholders")
			}
			e.Name = name
		}
	case "sort":
		key := func(e domain.ClientEndpoint) string {
			switch s.SortBy {
			case "name":
				return e.Name
			case "region":
				return e.Region
			case "protocol":
				return e.Connection.Protocol
			default:
				return ""
			}
		}
		if s.SortBy != "name" && s.SortBy != "region" && s.SortBy != "protocol" {
			return nil, fmt.Errorf("unknown sort field")
		}
		sort.SliceStable(nodes, func(i, j int) bool {
			a, b := key(nodes[i]), key(nodes[j])
			if a == b {
				return false
			}
			if s.Descending {
				return a > b
			}
			return a < b
		})
	case "deduplicate":
		out := []domain.ClientEndpoint{}
		seen := map[string]int{}
		for _, e := range nodes {
			if !domain.MatchesEndpoint(e, s.Filter) {
				out = append(out, e)
				continue
			}
			key := connectionKey(e.Connection)
			if i, ok := seen[key]; ok {
				for _, p := range e.Provenance {
					out[i].Provenance = appendUniqueProvenance(out[i].Provenance, p)
				}
			} else {
				seen[key] = len(out)
				out = append(out, e)
			}
		}
		return out, nil
	case "override":
		for i := range nodes {
			e := &nodes[i]
			if !domain.MatchesEndpoint(*e, s.Filter) {
				continue
			}
			if s.Override.Region != nil {
				e.Region = *s.Override.Region
			}
			if s.Override.Tags != nil {
				e.Tags = append([]string{}, (*s.Override.Tags)...)
			}
			if s.Override.Host != nil {
				e.Connection.Host = *s.Override.Host
			}
			if s.Override.Port != nil {
				e.Connection.Port = *s.Override.Port
			}
			if err := domain.ValidateConnection(e.Connection); err != nil {
				return nil, fmt.Errorf("invalid connection override: %w", err)
			}
		}
	default:
		return nil, fmt.Errorf("unknown processing kind")
	}
	return nodes, nil
}

// Equality includes credentials but is never returned, persisted or hashed into a
// public ID. Two equal names alone are not duplicate connections.
func connectionKey(c domain.Connection) string { b, _ := json.Marshal(c); return string(b) }
func clone(nodes []domain.ClientEndpoint) []domain.ClientEndpoint {
	out := append([]domain.ClientEndpoint{}, nodes...)
	for i := range out {
		out[i].Tags = append([]string{}, out[i].Tags...)
		out[i].Provenance = append([]domain.SourceRef{}, out[i].Provenance...)
		if out[i].Connection.TLS != nil {
			tls := *out[i].Connection.TLS
			tls.ALPN = append([]string{}, tls.ALPN...)
			if tls.Reality != nil {
				reality := *tls.Reality
				tls.Reality = &reality
			}
			out[i].Connection.TLS = &tls
		}
		if out[i].Connection.Transport != nil {
			transport := *out[i].Connection.Transport
			if transport.Headers != nil {
				transport.Headers = map[string]string{}
				for key, value := range out[i].Connection.Transport.Headers {
					transport.Headers[key] = value
				}
			}
			out[i].Connection.Transport = &transport
		}
	}
	return out
}
func appendUniqueProvenance(in []domain.SourceRef, p domain.SourceRef) []domain.SourceRef {
	for _, v := range in {
		if v == p {
			return in
		}
	}
	return append(in, p)
}
func stage(scope, sourceID, stepID string, before, after []domain.ClientEndpoint) Stage {
	s := Stage{Comparison: "snapshot", AddedIDs: []string{}, Scope: scope, SourceID: sourceID, StepID: stepID, Endpoints: clone(after), RemovedIDs: []string{}, ChangedIDs: []string{}}
	if scope == "source" || scope == "aggregate" {
		s.Comparison = "step-input"
		beforeIDs := map[string]bool{}
		for _, e := range before {
			beforeIDs[e.ID] = true
		}
		for _, e := range after {
			if !beforeIDs[e.ID] {
				s.AddedIDs = append(s.AddedIDs, e.ID)
			}
		}
	}
	index := map[string]domain.ClientEndpoint{}
	for _, e := range after {
		index[e.ID] = e
	}
	for _, old := range before {
		next, ok := index[old.ID]
		if !ok {
			s.RemovedIDs = append(s.RemovedIDs, old.ID)
		} else {
			a, _ := json.Marshal(old)
			b, _ := json.Marshal(next)
			if string(a) != string(b) {
				s.ChangedIDs = append(s.ChangedIDs, old.ID)
			}
		}
	}
	for i := range s.Endpoints {
		s.Endpoints[i].Connection.UUID = ""
		if s.Endpoints[i].Connection.Transport != nil {
			s.Endpoints[i].Connection.Transport.Headers = nil
		}
		if s.Endpoints[i].Connection.TLS != nil && s.Endpoints[i].Connection.TLS.Reality != nil {
			s.Endpoints[i].Connection.TLS.Reality.ShortID = ""
		}
		s.Endpoints[i].Connection.Username = ""
		s.Endpoints[i].Connection.Password = ""
	}
	return s
}
