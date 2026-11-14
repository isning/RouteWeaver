package store

import (
	"database/sql"
	"errors"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"time"
)

const rawCoreLogsKind = "raw-core-log-history"

func (s *Store) AcceptRawCoreLogs(r diagnostics.RawCoreReport, now time.Time) (diagnostics.RawCoreReceipt, error) {
	receipt := diagnostics.RawCoreReceipt{Sequence: r.Sequence, Digest: r.Digest}
	if e := r.Validate(now); e != nil {
		return receipt, e
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, r.Scope, now); e != nil {
			return e
		}
		h := diagnostics.RawCoreHistory{Events: []diagnostics.RawCoreRecord{}}
		e := s.getTx(tx, rawCoreLogsKind, r.Scope.InstanceID, &h)
		if e != nil && e != ErrNotFound {
			return e
		}
		if e == ErrNotFound {
			var count int
			if e = tx.QueryRow(`SELECT count(*) FROM records WHERE kind=?`, rawCoreLogsKind).Scan(&count); e != nil {
				return e
			}
			if count >= diagnostics.RawCoreInstanceLimit {
				return diagnostics.ErrRawCoreCapacity
			}
		}
		if h.Scope != r.Scope {
			h = diagnostics.RawCoreHistory{Scope: r.Scope, Events: []diagnostics.RawCoreRecord{}}
		}
		if r.Session == h.Session && r.Sequence == h.Sequence {
			if h.Digest != r.Digest {
				return diagnostics.ErrRawCoreConflict
			}
			receipt.Duplicate = true
			return nil
		}
		if (r.Session == h.Session && (h.Sequence == ^uint64(0) || r.Sequence != h.Sequence+1)) || (r.Session != h.Session && r.Sequence != 1) {
			return diagnostics.ErrRawCoreConflict
		}
		if h.LastReceivedAt != nil && now.Before(h.LastReceivedAt.Add(5*time.Second)) {
			return diagnostics.ErrRawCoreRate
		}
		diagnostics.PruneRawCoreHistory(&h, now)
		for _, event := range r.Events {
			h.Events = append(h.Events, diagnostics.RawCoreRecord{RawCoreEvent: event, ReceivedAt: now})
		}
		diagnostics.PruneRawCoreHistory(&h, now)
		h.Session = r.Session
		h.Sequence = r.Sequence
		h.Digest = r.Digest
		h.LastReceivedAt = &now
		// These are counts from the latest acknowledged interval, not silently
		// accumulating unbounded totals. Agent values saturate at RawCoreCounterLimit.
		h.Omitted = r.Omitted
		h.Dropped = r.Dropped
		return s.putTx(tx, rawCoreLogsKind, r.Scope.InstanceID, h)
	})
	return receipt, e
}
func (s *Store) RawCoreLogs(instanceID string, now time.Time) (diagnostics.RawCoreHistory, error) {
	h := diagnostics.RawCoreHistory{Events: []diagnostics.RawCoreRecord{}}
	if !domain.ValidID(instanceID) {
		return h, diagnostics.ErrInvalid
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		var instance domain.CoreInstance
		if e := s.getTx(tx, "core-instances", instanceID, &instance); e != nil {
			return e
		}
		if e := s.getTx(tx, rawCoreLogsKind, instanceID, &h); e == ErrNotFound {
			return nil
		} else if e != nil {
			return e
		}
		// Do not present a former enrollment's collection as current evidence.
		if e := s.diagnosticEnrollment(tx, h.Scope, now); errors.Is(e, diagnostics.ErrScope) {
			h = diagnostics.RawCoreHistory{Events: []diagnostics.RawCoreRecord{}}
			return nil
		} else if e != nil {
			return e
		}
		before := len(h.Events)
		diagnostics.PruneRawCoreHistory(&h, now)
		if len(h.Events) != before {
			return s.putTx(tx, rawCoreLogsKind, instanceID, h)
		}
		return nil
	})
	return h, e
}

// PruneRawCoreLogs removes expired event bodies, while retaining the small
// per-enrollment sequence fence. There are at most 64 histories of 128 events.
// The foreground server calls this every minute and on startup. Offline backups
// are independent retained copies and are not retroactively erased.
func (s *Store) PruneRawCoreLogs(now time.Time) error {
	ids := []string{}
	err := s.diagnosticTransaction(func(tx *sql.Tx) error {
		rows, e := tx.Query(`SELECT id FROM records WHERE kind=? ORDER BY id LIMIT ?`, rawCoreLogsKind, diagnostics.RawCoreInstanceLimit+1)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				return e
			}
			ids = append(ids, id)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return nil
	})
	if err != nil {
		return err
	}
	var failures []error
	if len(ids) > diagnostics.RawCoreInstanceLimit {
		failures = append(failures, diagnostics.ErrRawCoreCapacity)
	}
	// A corrupt history must not roll back retention cleanup for other instances.
	for _, id := range ids {
		e := s.diagnosticTransaction(func(tx *sql.Tx) error {
			var h diagnostics.RawCoreHistory
			if e := s.getTx(tx, rawCoreLogsKind, id, &h); e == ErrNotFound {
				return nil
			} else if e != nil {
				return e
			}
			obsolete, e := s.coreHistoryObsolete(tx, h.Scope, now)
			if e != nil {
				return e
			}
			if obsolete {
				_, e = s.deleteTx(tx, rawCoreLogsKind, id)
				return e
			}
			before := len(h.Events)
			diagnostics.PruneRawCoreHistory(&h, now)
			if len(h.Events) != before {
				return s.putTx(tx, rawCoreLogsKind, id, h)
			}
			return nil
		})
		if e != nil {
			failures = append(failures, e)
		}
	}
	return errors.Join(failures...)
}
