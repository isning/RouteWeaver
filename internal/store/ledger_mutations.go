package store

import (
	"database/sql"
	"errors"
)

// beginWriteTx reserves SQLite's writer before reads used by a mutation. The
// database reservation, not Store.mu, serializes independent Store handles.
func (s *Store) beginWriteTx() (*sql.Tx, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (s *Store) put(kind, id string, value any) error {
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.putTx(tx, kind, id, value); err != nil {
		return err
	}
	return tx.Commit()
}

// putTx is the only normal generic canonical writer. Importers deliberately use
// raw SQL inside their authenticated all-or-nothing transaction instead.
func (s *Store) putTx(tx *sql.Tx, kind, id string, value any) error {
	raw, err := s.seal(kind, id, value)
	if err != nil {
		return err
	}
	liveMutation, err := s.prepareAdmissionLiveMutationTx(tx, kind, id, raw)
	if err != nil {
		return err
	}
	var old, next *MeterRecord
	var generation int64
	clean := false
	if kind == "ledger" {
		if s.usageAEAD == nil || len(s.usageLookupKey) != 32 {
			return errors.New("missing derived crypto context")
		}
		if generation, clean, err = s.usageGenerationTx(tx); err != nil {
			return err
		}
		if clean {
			var prior MeterRecord
			if err = s.getTx(tx, kind, id, &prior); err == nil {
				old = &prior
			} else if err != ErrNotFound {
				clean = false
			}
			var decoded MeterRecord
			// Decode the serialized payload, not a type assertion: generic callers may
			// supply maps or RawMessage and still own exactly the same canonical fact.
			if s.open(kind, id, raw, &decoded) != nil {
				clean = false
			} else {
				next = &decoded
			}
			if old != nil && !validUsageContribution(old) || next != nil && !validUsageContribution(next) {
				clean = false
			}
		}
	}
	if _, err = tx.Exec(`INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, kind, id, raw); err != nil {
		return err
	}
	if err = s.finishAdmissionLiveMutationTx(tx, id, liveMutation); err != nil {
		return err
	}
	if kind == "ledger" && clean {
		if err = s.updateUsageHistoryTx(tx, generation, id, old, next); err != nil {
			return err
		}
		if err = s.updateUsageWindowsTx(tx, old, next); err != nil {
			return err
		}
		if err = s.updateUsageRebuildsTx(tx, id, old, next); err != nil {
			return err
		}
		return s.acknowledgeUsageMutationTx(tx, generation)
	}
	return nil
}

func (s *Store) deleteTx(tx *sql.Tx, kind, id string) (int64, error) {
	liveMutation, liveErr := s.prepareAdmissionLiveMutationTx(tx, kind, id, nil)
	if liveErr != nil {
		return 0, liveErr
	}
	var old *MeterRecord
	var generation int64
	clean := false
	var err error
	if kind == "ledger" {
		if s.usageAEAD == nil || len(s.usageLookupKey) != 32 {
			return 0, errors.New("missing derived crypto context")
		}
		if generation, clean, err = s.usageGenerationTx(tx); err != nil {
			return 0, err
		}
		if clean {
			var prior MeterRecord
			if err = s.getTx(tx, kind, id, &prior); err == nil {
				old = &prior
			} else {
				clean = false
			}
			if old != nil && !validUsageContribution(old) {
				clean = false
			}
		}
	}
	result, err := tx.Exec(`DELETE FROM records WHERE kind=? AND id=?`, kind, id)
	if err != nil {
		return 0, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if count > 0 {
		if err = s.finishAdmissionLiveMutationTx(tx, id, liveMutation); err != nil {
			return 0, err
		}
	}
	if kind == "users" && count > 0 {
		if err = s.deleteUsageRebuildTx(tx, id); err != nil {
			return 0, err
		}
	}
	if kind == "ledger" && count > 0 && clean {
		if err = s.updateUsageHistoryTx(tx, generation, id, old, nil); err != nil {
			return 0, err
		}
		if err = s.updateUsageWindowsTx(tx, old, nil); err != nil {
			return 0, err
		}
		if err = s.updateUsageRebuildsTx(tx, id, old, nil); err != nil {
			return 0, err
		}
		if err = s.acknowledgeUsageMutationTx(tx, generation); err != nil {
			return 0, err
		}
	}
	return count, nil
}
