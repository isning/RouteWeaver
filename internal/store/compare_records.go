package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"reflect"
	"sort"
)

// RecordCompare fences an input of a related-record transaction. Expected nil
// means the record must not exist. JSON numbers retain their full precision.
type RecordCompare struct {
	Kind     string
	ID       string
	Expected any
}

// RecordSetCompare fences membership as well as existing values: a newly added
// dependent record must invalidate a reviewed update too.
type RecordSetCompare struct {
	Kind string
	IDs  []string
}

// CompareAndPutRecords commits a group of encrypted records only if every
// reviewed input still matches, preventing partial updates or stale references.
func (s *Store) CompareAndPutRecords(compares []RecordCompare, writes []RecordWrite) error {
	return s.CompareSetsAndPutRecords(compares, nil, writes)
}

func (s *Store) CompareSetsAndPutRecords(compares []RecordCompare, sets []RecordSetCompare, writes []RecordWrite) error {
	return s.compareSetsAndPutRecords(compares, sets, writes, nil)
}

func (s *Store) compareSetsAndPutRecords(compares []RecordCompare, sets []RecordSetCompare, writes []RecordWrite, fence *ServicePolicyFence) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = s.compareRecordsTx(tx, compares, sets); e != nil {
		return e
	}
	if fence != nil {
		if e = s.checkServicePolicyFenceTx(tx, *fence); e != nil {
			return e
		}
	}
	for _, w := range writes {
		if e = s.putTx(tx, w.Kind, w.ID, w.Value); e != nil {
			return e
		}
	}
	if fence != nil {
		if e = s.checkServicePolicyFenceTx(tx, *fence); e != nil {
			return e
		}
	}
	return tx.Commit()
}

// compareRecordsTx runs under the store transaction and mutation lock.
func (s *Store) compareRecordsTx(tx *sql.Tx, compares []RecordCompare, sets []RecordSetCompare) error {
	var e error
	for _, set := range sets {
		rows, err := tx.Query(`SELECT id FROM records WHERE kind=? ORDER BY id`, set.Kind)
		if err != nil {
			return err
		}
		actual := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			actual = append(actual, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		expected := append([]string{}, set.IDs...)
		sort.Strings(expected)
		if !reflect.DeepEqual(actual, expected) {
			return ErrConflict
		}
	}
	for _, c := range compares {
		var encrypted []byte
		e = tx.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, c.Kind, c.ID).Scan(&encrypted)
		if c.Expected == nil {
			if e == sql.ErrNoRows {
				continue
			}
			if e == nil {
				return ErrConflict
			}
			return e
		}
		if e == sql.ErrNoRows {
			return ErrConflict
		}
		if e != nil {
			return e
		}
		var raw json.RawMessage
		if e = s.open(c.Kind, c.ID, encrypted, &raw); e != nil {
			return e
		}
		expected, e := json.Marshal(c.Expected)
		if e != nil {
			return e
		}
		var actual, want any
		a := json.NewDecoder(bytes.NewReader(raw))
		a.UseNumber()
		if e = a.Decode(&actual); e != nil {
			return e
		}
		b := json.NewDecoder(bytes.NewReader(expected))
		b.UseNumber()
		if e = b.Decode(&want); e != nil {
			return e
		}
		if !reflect.DeepEqual(actual, want) {
			return ErrConflict
		}
	}
	return nil
}
