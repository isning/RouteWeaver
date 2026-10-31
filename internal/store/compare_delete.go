package store

// CompareSetsAndRemoveRecord removes a record only while all inspected inputs
// and dependent-set memberships still match. The writer reservation fences both
// concurrent changes to existing references and newly created references across
// independent Store handles. Callers must include the record being removed in
// compares, as well as every relationship inspected before deciding to delete.
func (s *Store) CompareSetsAndRemoveRecord(kind, id string, compares []RecordCompare, sets []RecordSetCompare) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.compareRecordsTx(tx, compares, sets); err != nil {
		return err
	}
	n, err := s.deleteTx(tx, kind, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}
