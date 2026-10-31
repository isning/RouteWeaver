package store

import (
	"database/sql"
	"errors"
)

func (s *Store) SwapToken(kind, oldDigest, newDigest, recordID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if oldDigest != "" {
		if _, e = tx.Exec(`DELETE FROM token_index WHERE kind=? AND digest=?`, kind, oldDigest); e != nil {
			return e
		}
	}
	if newDigest != "" {
		if _, e = tx.Exec(`INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)`, kind, newDigest, recordID); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) LookupToken(kind, digest string) (string, error) {
	var id string
	e := s.db.QueryRow(`SELECT record_id FROM token_index WHERE kind=? AND digest=?`, kind, digest).Scan(&id)
	if e == sql.ErrNoRows {
		e = ErrNotFound
	}
	return id, e
}

// PutWithToken commits an encrypted record and bearer-token index transition
// together. A crash cannot strand a newly issued feed or leave its old token live.
func (s *Store) PutWithToken(kind, id string, value any, indexKind, oldDigest, newDigest, recordID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = s.putTx(tx, kind, id, value); e != nil {
		return e
	}
	if oldDigest != "" {
		if _, e = tx.Exec(`DELETE FROM token_index WHERE kind=? AND digest=?`, indexKind, oldDigest); e != nil {
			return e
		}
	}
	if newDigest != "" {
		if _, e = tx.Exec(`INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)`, indexKind, newDigest, recordID); e != nil {
			return e
		}
	}
	return tx.Commit()
}

var ErrConflict = errors.New("resource changed; reload and retry")

func (s *Store) CompareAndPutWithToken(kind, id string, expected, value any, indexKind, oldDigest, newDigest, recordID string) error {
	return s.CompareInputsAndPutWithToken(kind, id, expected, value, indexKind, oldDigest, newDigest, recordID, nil, nil)
}

// CompareInputsAndPutWithToken commits a record and token transition only when
// the record and every captured render input still match in the same transaction.
func (s *Store) CompareInputsAndPutWithToken(kind, id string, expected, value any, indexKind, oldDigest, newDigest, recordID string, inputs []RecordCompare, sets []RecordSetCompare) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	compares := append([]RecordCompare{{Kind: kind, ID: id, Expected: expected}}, inputs...)
	if e = s.compareRecordsTx(tx, compares, sets); e != nil {
		return e
	}
	if e = s.putTx(tx, kind, id, value); e != nil {
		return e
	}
	if oldDigest != "" {
		if _, e = tx.Exec(`DELETE FROM token_index WHERE kind=? AND digest=?`, indexKind, oldDigest); e != nil {
			return e
		}
	}
	if newDigest != "" {
		if _, e = tx.Exec(`INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)`, indexKind, newDigest, recordID); e != nil {
			return e
		}
	}
	return tx.Commit()
}
