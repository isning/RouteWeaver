package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"routeweaver/internal/domain"
)

var ErrAttributionCapacity = errors.New("output attribution history capacity exceeded")

const OutputAttributionHistoryLimit = 1000
const outputAttributionHistoryBytes = 8 << 20

// ListOutputAttributionIntents returns a complete, bounded owner snapshot with
// exact SQL identities for both value and membership CAS. No partial snapshot
// is returned on error. Both encrypted and decoded data have an 8 MiB budget.
// A creator must reject len(records) >= OutputAttributionHistoryLimit before
// adding a record, and include both returned proofs in its writer transaction.
// Terminal history counts toward capacity; this API does not prune history.
func (s *Store) ListOutputAttributionIntents(owner string) ([]RecordCompare, RecordSetCompare, error) {
	if !domain.ValidID(owner) {
		return nil, RecordSetCompare{}, fmt.Errorf("valid owner required")
	}
	kind := TenantKind(owner, "output-attribution-intents")
	rows, err := s.db.Query(`SELECT id,CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? ORDER BY id LIMIT 1001`, outputAttributionHistoryBytes, kind)
	if err != nil {
		return nil, RecordSetCompare{}, err
	}
	defer rows.Close()
	records := []RecordCompare{}
	set := RecordSetCompare{Kind: kind, IDs: []string{}}
	encryptedBytes, decodedBytes := 0, 0
	for rows.Next() {
		var id string
		var encrypted []byte
		if err = rows.Scan(&id, &encrypted); err != nil {
			return nil, RecordSetCompare{}, err
		}
		if len(records) >= OutputAttributionHistoryLimit || encrypted == nil || len(encrypted) > outputAttributionHistoryBytes-encryptedBytes {
			return nil, RecordSetCompare{}, ErrAttributionCapacity
		}
		encryptedBytes += len(encrypted)
		var raw json.RawMessage
		if err = s.open(kind, id, encrypted, &raw); err != nil {
			return nil, RecordSetCompare{}, err
		}
		if len(raw) > outputAttributionHistoryBytes-decodedBytes {
			return nil, RecordSetCompare{}, ErrAttributionCapacity
		}
		decodedBytes += len(raw)
		records = append(records, RecordCompare{Kind: kind, ID: id, Expected: raw})
		set.IDs = append(set.IDs, id)
	}
	if err = rows.Err(); err != nil {
		return nil, RecordSetCompare{}, err
	}
	return records, set, nil
}
