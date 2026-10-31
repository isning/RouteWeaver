package store

import (
	"database/sql"
	"errors"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"time"
)

func emptyNodeObservations() observability.State {
	return observability.State{Config: observability.Config{BilledInterfaces: []string{}}}
}
func (s *Store) NodeObservations(id string) (observability.State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := emptyNodeObservations()
	if !domain.ValidID(id) {
		return state, errors.New("valid node ID required")
	}
	var host domain.Host
	if e := s.get("hosts", id, &host); e != nil {
		return state, e
	}
	if e := s.get("node-observability", id, &state); e != nil && e != ErrNotFound {
		return state, e
	}
	return state, nil
}

// updateNodeObservations takes SQLite's write reservation before reading any
// scope/config/counter state. This also serializes separate Store handles or
// processes, not just callers sharing the in-memory mutex.
func (s *Store) updateNodeObservations(id string, change func(*sql.Tx, observability.State) (observability.State, error)) (observability.State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := emptyNodeObservations()
	if !domain.ValidID(id) {
		return state, errors.New("valid node ID required")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return state, e
	}
	defer tx.Rollback()
	// A no-op UPDATE obtains a write reservation even when no rows match. It
	// needs no new schema, lock record, or process-global synchronization.
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='node-observation-lock'`); e != nil {
		return state, e
	}
	var host domain.Host
	if e = s.getTx(tx, "hosts", id, &host); e != nil {
		return state, e
	}
	if e = s.getTx(tx, "node-observability", id, &state); e != nil && e != ErrNotFound {
		return state, e
	}
	next, e := change(tx, state)
	if e != nil {
		return state, e
	}
	if e = s.putTx(tx, "node-observability", id, next); e != nil {
		return state, e
	}
	if e = tx.Commit(); e != nil {
		return state, e
	}
	return next, nil
}
func (s *Store) ConfigureNodeObservations(id string, config observability.Config) (observability.State, error) {
	return s.updateNodeObservations(id, func(tx *sql.Tx, state observability.State) (observability.State, error) {
		if config.ObserverInstanceID != "" {
			var instance domain.CoreInstance
			if e := s.getTx(tx, "core-instances", config.ObserverInstanceID, &instance); e != nil {
				return state, e
			}
			if instance.HostID != id {
				return state, observability.ErrScope
			}
		}
		return observability.Configure(state, config)
	})
}
func (s *Store) AcceptNodeObservation(report observability.Report, now time.Time) (observability.Receipt, error) {
	var receipt observability.Receipt
	_, e := s.updateNodeObservations(report.Scope.NodeID, func(tx *sql.Tx, state observability.State) (observability.State, error) {
		var instance domain.CoreInstance
		if e := s.getTx(tx, "core-instances", report.Scope.InstanceID, &instance); e != nil || instance.HostID != report.Scope.NodeID {
			return state, observability.ErrScope
		}
		// Scope and latest enrollment are read under the same database write
		// reservation as the snapshot. A concurrent revoke either precedes the
		// entire ingestion or waits until its commit, never interleaves with it.
		var enrollment struct {
			Scope     observability.Scope `json:"scope"`
			Revoked   bool                `json:"revoked"`
			ExpiresAt time.Time           `json:"expiresAt"`
		}
		if e := s.getTx(tx, "instance-enrollments", report.Scope.InstanceID, &enrollment); e != nil {
			return state, observability.ErrScope
		}
		if enrollment.Scope != report.Scope || enrollment.Revoked || !now.Before(enrollment.ExpiresAt) {
			return state, observability.ErrScope
		}
		next, r, e := observability.Accept(state, report, now)
		receipt = r
		return next, e
	})
	return receipt, e
}
func (s *Store) ReconcileNodeProvider(id string, input observability.BaselineInput, actor string, now time.Time) (observability.State, error) {
	return s.updateNodeObservations(id, func(_ *sql.Tx, state observability.State) (observability.State, error) {
		return observability.Reconcile(state, input, actor, now)
	})
}
func (s *Store) RecordNodeProviderStatement(id string, input observability.StatementInput, actor string, now time.Time) (observability.State, error) {
	return s.updateNodeObservations(id, func(_ *sql.Tx, state observability.State) (observability.State, error) {
		return observability.RecordStatement(state, input, actor, now)
	})
}
