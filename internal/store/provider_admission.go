package store

import (
	"database/sql"
	"routeweaver/internal/observability"
	"time"
)

// Called under the same SQLite write reservation as admission acquire/renewal.
// Provider changes and admission decisions therefore have one serialization order.
func (s *Store) providerAdmissionTx(tx *sql.Tx, node string, now time.Time) (string, *time.Time, error) {
	var state observability.State
	if err := s.getTx(tx, "node-observability", node, &state); err == ErrNotFound {
		return "", nil, nil
	} else if err != nil {
		return "", nil, err
	}
	reason, until := observability.ManagedAdmission(state, now)
	return reason, until, nil
}
