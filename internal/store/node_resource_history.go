package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"time"
)

const nodeHistoryKind = "node-resource-history"
const nodeHistoryLimit = 256
const nodeHistoryBytes = 128 << 10

var ErrNodeHistoryCapacity = errors.New("node resource history capacity exceeded")
var errNodeHistoryInvalid = errors.New("invalid resource history record")

func (s *Store) resourceHistoryTx(ctx context.Context, tx *sql.Tx, id string) (observability.ResourceHistory, error) {
	h := observability.ResourceHistory{Points: []observability.ResourcePoint{}}
	var raw []byte
	var size int
	err := tx.QueryRowContext(ctx, `SELECT length(data),CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? AND id=?`, nodeHistoryBytes, nodeHistoryKind, id).Scan(&size, &raw)
	if err == sql.ErrNoRows {
		return h, ErrNotFound
	}
	if err != nil {
		return h, err
	}
	if size > nodeHistoryBytes {
		return h, ErrNodeHistoryCapacity
	}
	if err = s.open(nodeHistoryKind, id, raw, &h); err != nil {
		return h, errNodeHistoryInvalid
	}
	if len(h.Points) > observability.ResourceHistoryPoints {
		return h, ErrNodeHistoryCapacity
	}
	for i, p := range h.Points {
		if p.ObservedAt.IsZero() || (i > 0 && !p.ObservedAt.After(h.Points[i-1].ObservedAt)) || math.IsNaN(p.MemoryUsedPercent) || math.IsInf(p.MemoryUsedPercent, 0) || p.MemoryUsedPercent < 0 || p.MemoryUsedPercent > 100 {
			return h, errNodeHistoryInvalid
		}
		for _, v := range []*float64{p.CPUPercent, p.ReceiveBytesPerSecond, p.TransmitBytesPerSecond} {
			if v != nil && (math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0) {
				return h, errNodeHistoryInvalid
			}
		}
		if p.CPUPercent != nil && *p.CPUPercent > 100 {
			return h, errNodeHistoryInvalid
		}
	}
	return h, nil
}
func (s *Store) appendNodeResourceHistoryTx(tx *sql.Tx, id string, snapshot observability.Snapshot, now time.Time) error {
	h, err := s.resourceHistoryTx(context.Background(), tx, id)
	if err == ErrNotFound {
		var count int
		if err = tx.QueryRow(`SELECT count(*) FROM (SELECT 1 FROM records WHERE kind=? LIMIT ?)`, nodeHistoryKind, nodeHistoryLimit).Scan(&count); err != nil {
			return err
		}
		// Optional history capacity must not stop the existing latest-observation or
		// provider accounting path. The history endpoint explicitly reports capacity.
		if count >= nodeHistoryLimit {
			return nil
		}
	} else if errors.Is(err, errNodeHistoryInvalid) || errors.Is(err, ErrNodeHistoryCapacity) {
		// Damaged optional history remains visibly unavailable, but must not
		// roll back authoritative resource/provider observations.
		return nil
	} else if err != nil {
		return err
	}
	next, changed := observability.AppendResourceHistory(h, snapshot, now)
	if !changed {
		return nil
	}
	return s.putTx(tx, nodeHistoryKind, id, next)
}
func (s *Store) NodeResourceHistory(ctx context.Context, id string, now time.Time) (observability.ResourceHistoryView, error) {
	view := observability.ResourceHistoryView{NodeID: id, Available: true, IntervalSeconds: 300, WindowStart: now.Add(-observability.ResourceHistoryRetention), WindowEnd: now, Points: []observability.ResourcePoint{}}
	if !domain.ValidID(id) {
		return view, errors.New("invalid node ID")
	}
	if err := s.lockNotificationContext(ctx); err != nil {
		return view, err
	}
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return view, err
	}
	defer tx.Rollback()
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM records WHERE kind='hosts' AND id=?)`, id).Scan(&exists); err != nil {
		return view, err
	}
	if !exists {
		return view, ErrNotFound
	}
	h, err := s.resourceHistoryTx(ctx, tx, id)
	if err == ErrNotFound {
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM (SELECT 1 FROM records WHERE kind=? LIMIT ?)`, nodeHistoryKind, nodeHistoryLimit).Scan(&count); err != nil {
			return view, err
		}
		if count >= nodeHistoryLimit {
			view.Available = false
			view.Reason = "capacity"
		}
	} else if err != nil {
		return view, err
	}
	view.Points = observability.PruneResourceHistory(h, now).Points
	return view, tx.Commit()
}

// Bounded global retention: at most 256 * 288 compact samples. Each transaction
// touches one history, so cleanup yields the writer between nodes. Backups are
// independent retained copies. The service calls this on startup and each minute.
func (s *Store) PruneNodeResourceHistories(ctx context.Context, now time.Time) error {
	if err := s.lockNotificationContext(ctx); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM records WHERE kind=? LIMIT ?`, nodeHistoryKind, nodeHistoryLimit+1)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if len(ids) > nodeHistoryLimit {
		return ErrNodeHistoryCapacity
	}
	var invalid error
	for _, id := range ids {
		if err = s.pruneNodeResourceHistory(ctx, id, now); err != nil {
			if errors.Is(err, errNodeHistoryInvalid) || errors.Is(err, ErrNodeHistoryCapacity) {
				invalid = errors.Join(invalid, err)
				continue
			}
			return errors.Join(invalid, err)
		}
	}
	return invalid
}
func (s *Store) pruneNodeResourceHistory(ctx context.Context, id string, now time.Time) error {
	if err := s.lockNotificationContext(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	tx, err := s.beginNotificationWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	h, err := s.resourceHistoryTx(ctx, tx, id)
	if err == ErrNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	next := observability.PruneResourceHistory(h, now)
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM records WHERE kind='hosts' AND id=?)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists || len(next.Points) == 0 {
		_, err = s.deleteTx(tx, nodeHistoryKind, id)
	} else if len(next.Points) != len(h.Points) {
		err = s.putTx(tx, nodeHistoryKind, id, next)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
