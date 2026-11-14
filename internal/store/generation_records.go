package store

import (
	"database/sql"
	"fmt"
	"maps"
)

// CompareSetsAndGenerateRecord fences reviewed inputs, advances one generation,
// and commits its desired payload and associated journal/manifests atomically.
// The callback is pure: it must not call Store methods. A failed callback or
// associated write consumes no generation and exposes no partial desired state.
func (s *Store) CompareSetsAndGenerateRecord(kind, id string, compares []RecordCompare, sets []RecordSetCompare, build func(uint64) (any, []RecordWrite, error)) (uint64, error) {
	return s.compareSetsAndGenerateRecord(kind, id, compares, sets, build, nil)
}

func (s *Store) compareSetsAndGenerateRecord(kind, id string, compares []RecordCompare, sets []RecordSetCompare, build func(uint64) (any, []RecordWrite, error), fence *ServicePolicyFence) (uint64, error) {
	generations, e := s.compareSetsAndGenerateRecords(kind, []string{id}, compares, sets, func(generations map[string]uint64) ([]RecordWrite, error) {
		value, writes, e := build(generations[id])
		if e != nil {
			return nil, e
		}
		for _, w := range writes {
			if w.Kind == kind && w.ID == id {
				return nil, fmt.Errorf("associated write cannot replace generated record")
			}
		}
		return append(writes, RecordWrite{Kind: kind, ID: id, Value: value}), nil
	}, fence)
	return generations[id], e
}

// CompareSetsAndGenerateRecords fences reviewed inputs, advances each requested
// generation, and commits all generated records and associated writes atomically.
// The callback is pure: it must not call Store methods. Its result must include
// each requested kind/id exactly once, and no write may repeat a kind/id.
// Associated writes may use any kind, but only requested IDs receive generation
// counters. Any failure consumes no generations and exposes no partial state.
func (s *Store) CompareSetsAndGenerateRecords(kind string, ids []string, compares []RecordCompare, sets []RecordSetCompare, build func(map[string]uint64) ([]RecordWrite, error)) (map[string]uint64, error) {
	return s.compareSetsAndGenerateRecords(kind, ids, compares, sets, build, nil)
}

func (s *Store) compareSetsAndGenerateRecords(kind string, ids []string, compares []RecordCompare, sets []RecordSetCompare, build func(map[string]uint64) ([]RecordWrite, error), fence *ServicePolicyFence) (map[string]uint64, error) {
	return s.compareSetsAndGenerateRecordsPrepared(kind, ids, compares, sets, build, fence, nil)
}

func (s *Store) compareSetsAndGenerateRecordsPrepared(kind string, ids []string, compares []RecordCompare, sets []RecordSetCompare, build func(map[string]uint64) ([]RecordWrite, error), fence *ServicePolicyFence, prepare func(*sql.Tx, []RecordWrite) ([]RecordWrite, error)) (map[string]uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	if e = s.compareRecordsTx(tx, compares, sets); e != nil {
		return nil, e
	}
	if fence != nil {
		if e = s.checkServicePolicyFenceTx(tx, *fence); e != nil {
			return nil, e
		}
	}
	generations := make(map[string]uint64, len(ids))
	for _, id := range ids {
		if _, duplicate := generations[id]; duplicate {
			return nil, fmt.Errorf("duplicate generated record %s/%s", kind, id)
		}
		var n int64
		e = tx.QueryRow(`SELECT value FROM counters WHERE kind=? AND id=?`, kind, id).Scan(&n)
		if e != nil && e != sql.ErrNoRows {
			return nil, e
		}
		if n == int64(^uint64(0)>>1) {
			return nil, fmt.Errorf("generation exhausted")
		}
		generations[id] = uint64(n + 1)
	}
	writes, e := build(maps.Clone(generations))
	if e != nil {
		return nil, e
	}
	if prepare != nil {
		writes, e = prepare(tx, writes)
		if e != nil {
			return nil, e
		}
	}
	type recordKey struct{ kind, id string }
	seen := make(map[recordKey]bool, len(writes))
	for _, w := range writes {
		key := recordKey{w.Kind, w.ID}
		if seen[key] {
			return nil, fmt.Errorf("duplicate record write %s/%s", w.Kind, w.ID)
		}
		seen[key] = true
	}
	for _, id := range ids {
		if !seen[recordKey{kind, id}] {
			return nil, fmt.Errorf("missing generated record %s/%s", kind, id)
		}
	}
	for _, w := range writes {
		if e = s.putTx(tx, w.Kind, w.ID, w.Value); e != nil {
			return nil, e
		}
	}
	for _, id := range ids {
		if _, e = tx.Exec(`INSERT INTO counters(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value`, kind, id, int64(generations[id])); e != nil {
			return nil, e
		}
	}
	if fence != nil {
		if e = s.checkServicePolicyFenceTx(tx, *fence); e != nil {
			return nil, e
		}
	}
	return generations, tx.Commit()
}
