package store

import (
	"encoding/json"
	"routeweaver/internal/notifications"
)

// ReadNotifications is a private encrypted repository interface. Public state
// responses deliberately exclude this record and all notification credentials.
func (s *Store) ReadNotifications() (notifications.State, error) {
	state := notifications.DefaultState()
	if err := s.Get("notification-private", "state", &state); err != nil && err != ErrNotFound {
		return notifications.State{}, err
	}
	state.Normalize()
	return state, nil
}

// UpdateNotifications atomically records deduplication and outbox transitions,
// including leases. A crash never leaves a sent marker without its payload.
func (s *Store) UpdateNotifications(change func(*notifications.State) error) error {
	return s.UpdateRecords("notification-private", "state", func(raw json.RawMessage) ([]RecordWrite, error) {
		state := notifications.DefaultState()
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &state); err != nil {
				return nil, err
			}
		}
		state.Normalize()
		if err := change(&state); err != nil {
			return nil, err
		}
		return []RecordWrite{{Kind: "notification-private", ID: "state", Value: state}}, nil
	})
}
