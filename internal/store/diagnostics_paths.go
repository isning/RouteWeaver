package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"sort"
	"time"
)

type diagnosticObservation struct {
	Phase            string `json:"phase"`
	NativeChecked    bool   `json:"nativeChecked"`
	RecoveryRequired bool   `json:"recoveryRequired"`
	Observed         *struct {
		domain.DeploymentIdentity
		Known      bool      `json:"known"`
		Quiescent  bool      `json:"quiescent"`
		ObservedAt time.Time `json:"observedAt"`
	} `json:"observed"`
}

func (s *Store) diagnosticManifestTx(tx *sql.Tx, instance string, now time.Time) (domain.PublishedManifest, error) {
	var out domain.PublishedManifest
	var state diagnosticObservation
	if e := s.getTx(tx, "agent-observations", instance, &state); e != nil {
		return out, e
	}
	if state.Phase != "observed_conformant" || !state.NativeChecked || state.RecoveryRequired || state.Observed == nil || !state.Observed.Known || !state.Observed.Quiescent {
		return out, diagnostics.ErrScope
	}
	observed := state.Observed
	if observed.InstanceID != instance || observed.ObservedAt.IsZero() || observed.ObservedAt.After(now.Add(5*time.Second)) || now.Sub(observed.ObservedAt) > time.Minute {
		return out, diagnostics.ErrScope
	}
	if e := s.getTx(tx, "published-manifests", observed.RevisionID, &out); e != nil {
		return out, e
	}
	if out.Identity != observed.DeploymentIdentity || out.Program.Instance.ID != instance || out.Program.Instance.HostID != observed.NodeID || !now.Before(out.PolicyExpiresAt) {
		return out, diagnostics.ErrScope
	}
	scope := domain.InstanceScope{NodeID: observed.NodeID, InstanceID: instance, EnrollmentEpoch: observed.EnrollmentEpoch}
	if e := s.diagnosticEnrollment(tx, scope, now); e != nil {
		return out, e
	}
	return out, nil
}
func diagnosticConnector(m domain.PublishedManifest, route domain.PublishedRoute) (string, error) {
	if m.Identity.AdapterID != "routeweaver/managed-xray" || m.Program.Listener.ID != route.Path.Entry {
		return "", diagnostics.ErrScope
	}
	var action domain.ActionRef
	found := false
	for _, p := range m.Program.Principals {
		if p.RouteID == route.ID {
			if found && p.Action != action {
				return "", diagnostics.ErrScope
			}
			action = p.Action
			found = true
		}
	}
	if !found {
		return "", diagnostics.ErrScope
	}
	if action.Kind == "direct" && action.Ref == "" && len(route.EndpointIDs) == 1 {
		return "rw-direct", nil
	}
	if action.Kind != "forward" || action.Ref == "" || len(route.EndpointIDs) < 2 {
		return "", diagnostics.ErrScope
	}
	// Immutable legacy single-egress publications render exactly egress-1.
	// Multi-egress/ambiguous legacy graphs are not an accepted published path.
	if len(m.Program.Egress) == 1 && len(m.Program.Connectors) == 0 && action.Ref == "egress-1" {
		return action.Ref, nil
	}
	count := 0
	for _, c := range m.Program.Connectors {
		if c.ID == action.Ref {
			count++
		}
	}
	if count != 1 {
		return "", diagnostics.ErrScope
	}
	return action.Ref, nil
}

// Resolution occurs inside the writer transaction that queues/claims a job.
// No mutable draft or public request can supply a native connector override.
func (s *Store) diagnosticPathsTx(tx *sql.Tx, now time.Time) ([]diagnostics.AvailablePath, error) {
	records, e := s.listTx(tx, "agent-observations")
	if e != nil {
		return nil, e
	}
	manifests := map[string]domain.PublishedManifest{}
	ambiguous := map[string]bool{}
	for _, raw := range records {
		var state diagnosticObservation
		if json.Unmarshal(raw, &state) != nil || state.Observed == nil {
			continue
		}
		m, e := s.diagnosticManifestTx(tx, state.Observed.InstanceID, now)
		if e != nil {
			continue
		}
		id := m.Program.Listener.ID
		if _, exists := manifests[id]; exists {
			ambiguous[id] = true
		}
		manifests[id] = m
	}
	out := []diagnostics.AvailablePath{}
	for _, m := range manifests {
		for _, route := range m.Routes {
			if route.Path.Entry != m.Program.Listener.ID || ambiguous[route.Path.Entry] {
				continue
			}
			connector, e := diagnosticConnector(m, route)
			if e != nil {
				continue
			}
			path := diagnostics.ManagedPath{RouteID: route.ID, DeploymentID: m.DeploymentID, Fingerprint: m.Fingerprint, EntryEndpointID: route.Path.Entry, ExitEndpointID: route.Path.Exit, ConnectorID: connector, Hops: []diagnostics.PathHop{}}
			valid := true
			for _, endpoint := range route.EndpointIDs {
				hop, ok := manifests[endpoint]
				if !ok || ambiguous[endpoint] || hop.DeploymentID != m.DeploymentID || hop.Fingerprint != m.Fingerprint {
					valid = false
					break
				}
				found := false
				for _, other := range hop.Routes {
					if other.ID == route.ID && diagnostics.Digest(other) == diagnostics.Digest(route) {
						found = true
					}
				}
				if !found {
					valid = false
					break
				}
				path.Hops = append(path.Hops, diagnostics.PathHop{EndpointID: endpoint, Identity: hop.Identity})
			}
			scope := domain.InstanceScope{NodeID: m.Identity.NodeID, InstanceID: m.Identity.InstanceID, EnrollmentEpoch: m.Identity.EnrollmentEpoch}
			if !valid || path.Validate(scope, route.ID) != nil {
				continue
			}
			out = append(out, diagnostics.AvailablePath{PublishedRouteID: route.ID, Name: route.Name, InstanceID: m.Identity.InstanceID, NodeID: m.Identity.NodeID, ManagedPath: path})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].PublishedRouteID+out[i].InstanceID < out[j].PublishedRouteID+out[j].InstanceID
	})
	return out, nil
}
func (s *Store) DiagnosticPaths(now time.Time) (out []diagnostics.AvailablePath, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error { var e error; out, e = s.diagnosticPathsTx(tx, now); return e })
	return
}
func (s *Store) selectDiagnosticPathTx(tx *sql.Tx, route, instance string, now time.Time) (*diagnostics.ManagedPath, error) {
	paths, e := s.diagnosticPathsTx(tx, now)
	if e != nil {
		return nil, e
	}
	var found *diagnostics.ManagedPath
	for _, p := range paths {
		if p.PublishedRouteID == route && p.InstanceID == instance {
			if found != nil {
				return nil, errors.New("selected managed diagnostic path is ambiguous")
			}
			copy := p.ManagedPath
			found = &copy
		}
	}
	if found == nil {
		return nil, diagnostics.ErrScope
	}
	return found, nil
}
func (s *Store) diagnosticPathCurrentTx(tx *sql.Tx, j diagnostics.Job, now time.Time) error {
	if j.PathMode != "managed_route" {
		return nil
	}
	if j.ManagedPath == nil {
		return diagnostics.ErrScope
	}
	current, e := s.selectDiagnosticPathTx(tx, j.PublishedRouteID, j.InstanceID, now)
	if e != nil {
		return e
	}
	if diagnostics.Digest(current) != diagnostics.Digest(j.ManagedPath) {
		return diagnostics.ErrScope
	}
	return nil
}
