package store

import (
	"database/sql"
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"time"
)

const coreDiagnosticsKind = "core-diagnostic-history"

func (s *Store) AcceptCoreDiagnostics(r diagnostics.CoreReport, now time.Time) (diagnostics.CoreReceipt, error) {
	receipt := diagnostics.CoreReceipt{Sequence: r.Sequence, Digest: r.Digest}
	if e := r.Validate(now); e != nil {
		return receipt, e
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, r.Scope, now); e != nil {
			return e
		}
		h := diagnostics.CoreHistory{Events: []diagnostics.CoreRecord{}}
		e := s.getTx(tx, coreDiagnosticsKind, r.Scope.InstanceID, &h)
		if e != nil && e != ErrNotFound {
			return e
		}
		if e == ErrNotFound {
			var count int
			if e = tx.QueryRow(`SELECT count(*) FROM records WHERE kind=?`, coreDiagnosticsKind).Scan(&count); e != nil {
				return e
			}
			if count >= diagnostics.CoreInstanceLimit {
				return diagnostics.ErrCoreCapacity
			}
		}
		if h.Scope != r.Scope {
			h = diagnostics.CoreHistory{Scope: r.Scope, Events: []diagnostics.CoreRecord{}}
		}
		if r.Sequence == h.Sequence {
			if h.Digest != r.Digest {
				return diagnostics.ErrCoreConflict
			}
			receipt.Duplicate = true
			return nil
		}
		if h.Sequence == ^uint64(0) || r.Sequence != h.Sequence+1 {
			return diagnostics.ErrCoreConflict
		}
		if h.LastReceivedAt != nil && now.Before(h.LastReceivedAt.Add(5*time.Second)) {
			return diagnostics.ErrCoreRate
		}
		diagnostics.PruneCoreHistory(&h, now)
		for _, event := range r.Events {
			h.Events = append(h.Events, diagnostics.CoreRecord{CoreEvent: event, ReceivedAt: now})
		}
		diagnostics.PruneCoreHistory(&h, now)
		h.Sequence = r.Sequence
		h.Digest = r.Digest
		h.LastReceivedAt = &now
		// These are counts from the latest acknowledged interval, not silently
		// accumulating unbounded totals. Agent values saturate at CoreCounterLimit.
		h.Omitted = r.Omitted
		h.Dropped = r.Dropped
		return s.putTx(tx, coreDiagnosticsKind, r.Scope.InstanceID, h)
	})
	return receipt, e
}
func (s *Store) CoreDiagnostics(instanceID string, now time.Time) (diagnostics.CoreHistory, error) {
	h := diagnostics.CoreHistory{Events: []diagnostics.CoreRecord{}}
	if !domain.ValidID(instanceID) {
		return h, diagnostics.ErrInvalid
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		var instance domain.CoreInstance
		if e := s.getTx(tx, "core-instances", instanceID, &instance); e != nil {
			return e
		}
		if e := s.getTx(tx, coreDiagnosticsKind, instanceID, &h); e == ErrNotFound {
			return nil
		} else if e != nil {
			return e
		}
		// Do not present a former enrollment's collection as current evidence.
		if e := s.diagnosticEnrollment(tx, h.Scope, now); errors.Is(e, diagnostics.ErrScope) {
			h = diagnostics.CoreHistory{Events: []diagnostics.CoreRecord{}}
			return nil
		} else if e != nil {
			return e
		}
		diagnostics.PruneCoreHistory(&h, now)
		return s.putTx(tx, coreDiagnosticsKind, instanceID, h)
	})
	return h, e
}

// PruneCoreDiagnostics removes expired event bodies, while retaining the small
// per-enrollment sequence fence. There are at most 256 histories of 128 events.
// The foreground server calls this every minute and on startup. Offline backups
// are independent retained copies and are not retroactively erased.
func (s *Store) PruneCoreDiagnostics(now time.Time) error {
	return s.diagnosticTransaction(func(tx *sql.Tx) error {
		rows, e := tx.Query(`SELECT id FROM records WHERE kind=? LIMIT ?`, coreDiagnosticsKind, diagnostics.CoreInstanceLimit+1)
		if e != nil {
			return e
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if len(ids) > diagnostics.CoreInstanceLimit {
			return diagnostics.ErrCoreCapacity
		}
		for _, id := range ids {
			var h diagnostics.CoreHistory
			if e = s.getTx(tx, coreDiagnosticsKind, id, &h); e != nil {
				return e
			}
			// Revoked, expired and removed enrollments cannot report again. Deleting
			// their histories also frees capacity without weakening an active fence.
			obsolete, err := s.coreHistoryObsolete(tx, h.Scope, now)
			if err != nil {
				return err
			}
			if obsolete {
				if _, e = s.deleteTx(tx, coreDiagnosticsKind, id); e != nil {
					return e
				}
				continue
			}

			before := len(h.Events)
			diagnostics.PruneCoreHistory(&h, now)
			if len(h.Events) != before {
				if e = s.putTx(tx, coreDiagnosticsKind, id, h); e != nil {
					return e
				}
			}
		}
		return nil
	})
}

// Cleanup must distinguish missing/revoked enrollment from a corrupted read;
// an opaque storage failure is not permission to erase sequence fences.
func (s *Store) coreHistoryObsolete(tx *sql.Tx, scope domain.InstanceScope, now time.Time) (bool, error) {
	var enrollment struct {
		Scope     domain.InstanceScope `json:"scope"`
		Revoked   bool                 `json:"revoked"`
		ExpiresAt time.Time            `json:"expiresAt"`
	}
	e := s.getTx(tx, "instance-enrollments", scope.InstanceID, &enrollment)
	if e == ErrNotFound {
		return true, nil
	}
	if e != nil {
		return false, e
	}
	if enrollment.Scope != scope || enrollment.Revoked || !now.Before(enrollment.ExpiresAt) {
		return true, nil
	}
	var instance domain.CoreInstance
	e = s.getTx(tx, "core-instances", scope.InstanceID, &instance)
	if e == ErrNotFound {
		return true, nil
	}
	if e != nil {
		return false, e
	}
	return instance.HostID != scope.NodeID, nil
}
