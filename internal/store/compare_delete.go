package store

// RecordDelete identifies one record in an atomic removal.
type RecordDelete struct {
	Kind string
	ID   string
}

// CompareSetsAndRemoveRecord removes a record only while all inspected inputs
// and dependent-set memberships still match. The writer reservation fences both
// concurrent changes to existing references and newly created references across
// independent Store handles. Callers must include the record being removed in
// compares, as well as every relationship inspected before deciding to delete.
func (s *Store) CompareSetsAndRemoveRecord(kind, id string, compares []RecordCompare, sets []RecordSetCompare) error {
	return s.CompareSetsAndRemoveRecords([]RecordDelete{{Kind: kind, ID: id}}, compares, sets)
}

// CompareSetsAndRemoveRecords removes related records in one transaction. Every
// removal must exist and be included in compares. Optional absent relationships
// belong in compares with Expected nil, but not in removals. A missing removal,
// changed input or changed dependent set leaves every record untouched.
func (s *Store) CompareSetsAndRemoveRecords(removals []RecordDelete, compares []RecordCompare, sets []RecordSetCompare) error {
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
	for _, record := range removals {
		n, err := s.deleteTx(tx, record.Kind, record.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
	}
	return tx.Commit()
}
