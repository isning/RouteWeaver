package store

import (
	"reflect"
	"routeweaver/internal/service"
	"time"
)

// ComparePolicyAndPutRecords fences provisioning against a concurrent membership,
// service, individual-override or direct-route change. The canonical policy is
// re-evaluated under the same SQLite writer reservation as all resulting writes.
func (s *Store) ComparePolicyAndPutRecords(expected service.EffectivePolicy, compares []RecordCompare, writes []RecordWrite) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	actual, e := s.effectivePolicyTx(tx, expected.UserID, time.Now().UTC())
	if e != nil {
		return e
	}
	if actual.Status != "active" || !reflect.DeepEqual(actual, expected) {
		return ErrConflict
	}
	if e = s.compareRecordsTx(tx, compares, nil); e != nil {
		return e
	}
	for _, write := range writes {
		if e = s.putTx(tx, write.Kind, write.ID, write.Value); e != nil {
			return e
		}
	}
	return tx.Commit()
}
