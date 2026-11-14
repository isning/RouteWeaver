package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"time"
)

const nodeHistoryKind = "node-resource-history"
const nodeHourlyKind = "node-resource-hourly"
const nodeHistoryLimit = 256
const nodeHistoryBytes = 128 << 10

var ErrNodeHistoryCapacity = errors.New("node resource history capacity exceeded")
var errNodeHistoryInvalid = errors.New("invalid resource history record")

func (s *Store) resourceHistoryTx(ctx context.Context, tx *sql.Tx, id string, kinds ...string) (observability.ResourceHistory, error) {
	kind := nodeHistoryKind
	if len(kinds) > 0 {
		kind = kinds[0]
	}
	h := observability.ResourceHistory{Points: []observability.ResourcePoint{}}
	var raw []byte
	var size int
	err := tx.QueryRowContext(ctx, `SELECT length(data),CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? AND id=?`, nodeHistoryBytes, kind, id).Scan(&size, &raw)
	if err == sql.ErrNoRows {
		return h, ErrNotFound
	}
	if err != nil {
		return h, err
	}
	if size > nodeHistoryBytes {
		return h, ErrNodeHistoryCapacity
	}
	if err = s.open(kind, id, raw, &h); err != nil {
		return h, errNodeHistoryInvalid
	}
	if len(h.Points) > observability.ResourceHistoryPoints || len(h.Hourly) > 168 {
		return h, ErrNodeHistoryCapacity
	}
	for _, points := range [][]observability.ResourcePoint{h.Points, h.Hourly} {
		for i, p := range points {
			if p.ObservedAt.IsZero() || (i > 0 && !p.ObservedAt.After(points[i-1].ObservedAt)) || math.IsNaN(p.MemoryUsedPercent) || math.IsInf(p.MemoryUsedPercent, 0) || p.MemoryUsedPercent < 0 || p.MemoryUsedPercent > 100 {
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
	}
	return h, nil
}

// Both tiers participate in the authoritative observation transaction, but a
// damaged optional tier is isolated. Only the tier that changes is encrypted.
func (s *Store) appendNodeResourceHistoryTx(tx *sql.Tx, id string, snapshot observability.Snapshot, now time.Time) error {
	var admitted bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM records WHERE kind IN (?,?) AND id=?)`, nodeHistoryKind, nodeHourlyKind, id).Scan(&admitted); err != nil {
		return err
	}
	if !admitted {
		count, err := historyNodeCount(context.Background(), tx)
		if err != nil {
			return err
		}
		if count >= nodeHistoryLimit {
			return nil
		}
	}
	for _, kind := range []string{nodeHistoryKind, nodeHourlyKind} {
		h, err := s.resourceHistoryTx(context.Background(), tx, id, kind)
		if errors.Is(err, errNodeHistoryInvalid) || errors.Is(err, ErrNodeHistoryCapacity) {
			continue
		}
		if err != nil && err != ErrNotFound {
			return err
		}
		next, _ := observability.AppendResourceHistory(h, snapshot, now)
		limit := 80 << 10
		if kind == nodeHistoryKind {
			next.Hourly = nil
		} else {
			next.Points = nil
			limit = 48 << 10
		}
		if reflect.DeepEqual(next, h) {
			continue
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if len(encoded)+s.aead.NonceSize()+s.aead.Overhead() > limit {
			continue
		}
		if err = s.putTx(tx, kind, id, next); err != nil {
			return err
		}
	}
	return nil
}
func historyNodeCount(ctx context.Context, tx *sql.Tx) (int, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM (SELECT DISTINCT id FROM records WHERE kind IN (?,?) LIMIT ?)`, nodeHistoryKind, nodeHourlyKind, nodeHistoryLimit).Scan(&count)
	return count, err
}
func (s *Store) NodeResourceHistory(ctx context.Context, id string, now time.Time, windows ...string) (observability.ResourceHistoryView, error) {
	view := observability.ResourceHistoryView{NodeID: id, Available: true, IntervalSeconds: 300, WindowStart: now.Add(-observability.ResourceHistoryRetention), WindowEnd: now, Points: []observability.ResourcePoint{}}
	window := "24h"
	if len(windows) > 0 {
		window = windows[0]
	}
	switch window {
	case "1h":
		view.WindowStart = now.Add(-time.Hour)
	case "24h":
	case "7d":
		view.WindowStart = now.Add(-7 * 24 * time.Hour)
		view.IntervalSeconds = 3600
	default:
		return view, errors.New("invalid history window")
	}
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
	kind := nodeHistoryKind
	if window == "7d" {
		kind = nodeHourlyKind
	}
	h, err := s.resourceHistoryTx(ctx, tx, id, kind)
	if err == ErrNotFound {
		var admitted bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM records WHERE kind IN (?,?) AND id=?)`, nodeHistoryKind, nodeHourlyKind, id).Scan(&admitted); err != nil {
			return view, err
		}
		count, e := historyNodeCount(ctx, tx)
		if e != nil {
			err = e
			return view, err
		}
		if count >= nodeHistoryLimit && !admitted {
			view.Available = false
			view.Reason = "capacity"
		}
	} else if err != nil {
		return view, err
	}
	pruned := observability.PruneResourceHistory(h, now)
	points := pruned.Points
	if window == "7d" {
		points = pruned.Hourly
	}
	for _, p := range points {
		if p.ObservedAt.After(view.WindowStart) && !p.ObservedAt.After(now) {
			view.Points = append(view.Points, p)
		}
	}
	return view, tx.Commit()
}

// Bounded global retention: at most 256 * (288 + 168) compact samples. Each transaction
// touches one history, so cleanup yields the writer between nodes. Backups are
// independent retained copies. The service calls this on startup and each minute.
func (s *Store) PruneNodeResourceHistories(ctx context.Context, now time.Time) error {
	if err := s.lockNotificationContext(ctx); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT id FROM records WHERE kind IN (?,?) LIMIT ?`, nodeHistoryKind, nodeHourlyKind, nodeHistoryLimit+1)
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
		for _, kind := range []string{nodeHistoryKind, nodeHourlyKind} {
			if err = s.pruneNodeResourceHistory(ctx, id, now, kind); err != nil {
				if errors.Is(err, errNodeHistoryInvalid) || errors.Is(err, ErrNodeHistoryCapacity) {
					invalid = errors.Join(invalid, err)
					continue
				}
				return errors.Join(invalid, err)
			}
		}
	}
	return invalid
}
func (s *Store) pruneNodeResourceHistory(ctx context.Context, id string, now time.Time, kind string) error {
	if err := s.lockNotificationContext(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	tx, err := s.beginNotificationWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	h, err := s.resourceHistoryTx(ctx, tx, id, kind)
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
	if !exists || len(next.Points) == 0 && len(next.Hourly) == 0 {
		_, err = s.deleteTx(tx, kind, id)
	} else if len(next.Points) != len(h.Points) || len(next.Hourly) != len(h.Hourly) {
		err = s.putTx(tx, kind, id, next)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
