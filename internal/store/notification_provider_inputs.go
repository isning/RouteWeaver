package store

import (
	"context"
	"database/sql"
	"errors"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
)

type NotificationProviderInput struct {
	Host  domain.Host
	State observability.State
}

// NotificationProviderInputs reads current host observations in one cancellable
// read snapshot. It does not enter the non-context inventory APIs while a worker
// deadline is active. The allocation is O(current hosts), not historical samples.
func (s *Store) NotificationProviderInputs(ctx context.Context) ([]NotificationProviderInput, error) {
	if err := s.lockNotificationContext(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT h.id,h.data,o.data FROM records h LEFT JOIN records o ON o.kind='node-observability' AND o.id=h.id WHERE h.kind='hosts' ORDER BY h.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NotificationProviderInput{}
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		var id string
		var host, state []byte
		if err = rows.Scan(&id, &host, &state); err != nil {
			return nil, err
		}
		input := NotificationProviderInput{State: emptyNodeObservations()}
		if err = s.open("hosts", id, host, &input.Host); err != nil {
			return nil, err
		}
		if input.Host.ID != id {
			return nil, errors.New("host record identity mismatch")
		}
		if state != nil {
			if err = s.open("node-observability", id, state, &input.State); err != nil {
				return nil, err
			}
		}
		out = append(out, input)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}
