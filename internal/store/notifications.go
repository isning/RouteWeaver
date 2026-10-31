package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"routeweaver/internal/notifications"
	"time"
)

const notificationConfigKind = "notification-config"
const notificationEventKind = "notification-events"
const notificationDeliveryKind = "notification-deliveries"
const notificationReadKind = "notification-reads"
const notificationAnnouncementKind = "notification-announcements"
const notificationPendingKind = "notification-pending"
const notificationHistoryKind = "notification-history"
const notificationInboxPrefix = "notification-inbox/"

type notificationConfig struct {
	Version  int
	Settings notifications.Settings
	Secrets  notifications.Secrets
}

// Each accepted fact is a separate encrypted record. Index records contain only
// encrypted references/copies; terminal history is never removed by dispatch.
func (s *Store) initializeNotifications() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.migrateNotificationsTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) migrateNotificationsTx(tx *sql.Tx) error {
	var old notifications.State
	var legacy json.RawMessage
	err := s.getTx(tx, "notification-private", "state", &legacy)
	if err == ErrNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	old, err = decodeLegacyNotifications(legacy)
	if err != nil {
		return err
	}
	var config notificationConfig
	if err = s.getTx(tx, notificationConfigKind, "settings", &config); err == nil {
		return fmt.Errorf("mixed legacy and current notification state; migration refused")
	} else if err != ErrNotFound {
		return err
	}
	old.Normalize()
	if err = s.writeNotificationChangesTx(tx, notifications.State{}, old); err != nil {
		return err
	}
	// Deleting the old representation is the last step in the same transaction;
	// failure rolls back every new row and leaves the original fully recoverable.
	_, err = s.deleteTx(tx, "notification-private", "state")
	return err
}
func decodeLegacyNotifications(raw json.RawMessage) (notifications.State, error) {
	var state notifications.State
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return state, fmt.Errorf("unsupported legacy notification state")
	}
	state.Normalize()
	return state, nil
}
func (s *Store) ReadNotifications() (notifications.State, error) {
	return s.ReadNotificationsScope(notifications.Scope{All: true})
}
func (s *Store) UpdateNotifications(change func(*notifications.State) error) error {
	return s.UpdateNotificationsScope(notifications.Scope{All: true}, change)
}
func (s *Store) ReadNotificationsScope(scope notifications.Scope) (notifications.State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return notifications.State{}, err
	}
	defer tx.Rollback()
	if err = s.migrateNotificationsTx(tx); err != nil {
		return notifications.State{}, err
	}
	state, err := s.readNotificationsTx(tx, scope)
	if err != nil {
		return notifications.State{}, err
	}
	return state, tx.Commit()
}
func (s *Store) UpdateNotificationsScope(scope notifications.Scope, change func(*notifications.State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.migrateNotificationsTx(tx); err != nil {
		return err
	}
	state, err := s.readNotificationsTx(tx, scope)
	if err != nil {
		return err
	}
	// Snapshot only the requested slice, never the entire historical ledger.
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	var before notifications.State
	if err = json.Unmarshal(raw, &before); err != nil {
		return err
	}
	if err = change(&state); err != nil {
		return err
	}
	if err = s.writeNotificationChangesTx(tx, before, state); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) readNotificationsTx(tx *sql.Tx, scope notifications.Scope) (notifications.State, error) {
	state := notifications.DefaultState()
	var config notificationConfig
	if err := s.getTx(tx, notificationConfigKind, "settings", &config); err == nil {
		if config.Version != 1 {
			return state, fmt.Errorf("unsupported notification storage version")
		}
		state.Settings = config.Settings
		state.Secrets = config.Secrets
	} else if err != ErrNotFound {
		return state, err
	}
	if scope.All || scope.Announcements {
		if err := readNotificationMap(s, tx, notificationAnnouncementKind, state.Announcements); err != nil {
			return state, err
		}
	}
	if scope.All {
		if err := readNotificationMap(s, tx, notificationEventKind, state.Events); err != nil {
			return state, err
		}
		if err := readNotificationMap(s, tx, notificationDeliveryKind, state.Deliveries); err != nil {
			return state, err
		}
		if err := readNotificationMap(s, tx, notificationReadKind, state.Reads); err != nil {
			return state, err
		}
		return state, nil
	}
	ids := append([]string{}, scope.EventIDs...)
	if scope.SelectEventIDs != nil {
		ids = append(ids, scope.SelectEventIDs(state)...)
	}
	for _, id := range ids {
		if err := s.loadNotificationEventTx(tx, &state, id, scope.ReceiptOwner); err != nil {
			return state, err
		}
	}
	if scope.PendingAt != nil {
		// Walk only active work. Delayed/leased items do not hide later due work;
		// memory is bounded to 128 due deliveries, irrespective of terminal history.
		rows, err := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, notificationPendingKind)
		if err != nil {
			return state, err
		}
		due := []notifications.Delivery{}
		for rows.Next() {
			var id string
			var b []byte
			if err = rows.Scan(&id, &b); err != nil {
				break
			}
			var d notifications.Delivery
			if err = s.open(notificationPendingKind, id, b, &d); err != nil {
				break
			}
			if id != d.EventID+"/"+d.Channel || d.Status != "queued" && d.Status != "retrying" && d.Status != "sending" {
				err = fmt.Errorf("inconsistent notification pending index")
				break
			}
			if scope.OnlyChannel != "" && scope.OnlyChannel != d.Channel || scope.PendingEventID != "" && scope.PendingEventID != d.EventID {
				continue
			}
			if scope.PendingAt.Before(d.NextAttemptAt) || d.Status == "sending" && scope.PendingAt.Before(d.LeaseUntil) {
				continue
			}
			due = append(due, d)
			if len(due) == 128 {
				break
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return state, err
		}
		for _, d := range due {
			if err = s.loadNotificationEventTx(tx, &state, d.EventID, ""); err != nil {
				return state, err
			}
			canonical, ok := state.Deliveries[d.EventID+"/"+d.Channel]
			a, _ := json.Marshal(canonical)
			b, _ := json.Marshal(d)
			if _, exists := state.Events[d.EventID]; !exists || !ok || !bytes.Equal(a, b) {
				return state, fmt.Errorf("inconsistent notification pending index")
			}
		}
	}
	if scope.Inbox != nil {
		kinds := []string{notificationInboxPrefix + scope.Inbox.ID}
		if scope.Inbox.Role == "admin" {
			kinds = append(kinds, notificationInboxPrefix+"@admins")
		}
		for _, kind := range kinds {
			if err := s.readNotificationInboxTx(tx, &state, kind, *scope.Inbox, scope.InboxAt); err != nil {
				return state, err
			}
		}
	}
	if scope.History {
		refs, err := s.notificationIndexRefsTx(tx, notificationHistoryKind, 500)
		if err != nil {
			return state, err
		}
		for _, id := range refs {
			var d notifications.Delivery
			if err = s.getTx(tx, notificationDeliveryKind, id, &d); err != nil {
				return state, err
			}
			state.Deliveries[id] = d
			if err = s.loadNotificationPayloadTx(tx, &state, d.EventID); err != nil {
				return state, err
			}
			if _, ok := state.Events[d.EventID]; !ok {
				return state, fmt.Errorf("inconsistent notification history index")
			}
		}
	}
	return state, nil
}
func readNotificationMap[T any](s *Store, tx *sql.Tx, kind string, out map[string]T) error {
	rows, err := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, kind)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			return err
		}
		var v T
		if err = s.open(kind, id, b, &v); err != nil {
			return err
		}
		out[id] = v
	}
	return rows.Err()
}
func (s *Store) loadNotificationPayloadTx(tx *sql.Tx, state *notifications.State, id string) error {
	if _, ok := state.Events[id]; ok {
		return nil
	}
	var event notifications.Event
	if err := s.getTx(tx, notificationEventKind, id, &event); err == ErrNotFound {
		return nil
	} else if err != nil {
		return err
	}
	state.Events[id] = event
	return nil
}
func (s *Store) loadNotificationEventTx(tx *sql.Tx, state *notifications.State, id, owner string) error {
	if err := s.loadNotificationPayloadTx(tx, state, id); err != nil {
		return err
	}
	if event, ok := state.Events[id]; ok && event.AnnouncementID != "" {
		if _, loaded := state.Announcements[event.AnnouncementID]; !loaded {
			var a notifications.Announcement
			if err := s.getTx(tx, notificationAnnouncementKind, event.AnnouncementID, &a); err == nil {
				state.Announcements[event.AnnouncementID] = a
			} else if err != ErrNotFound {
				return err
			}
		}
	}
	for _, channel := range []string{"in-app", "email", "webhook"} {
		key := id + "/" + channel
		var d notifications.Delivery
		if err := s.getTx(tx, notificationDeliveryKind, key, &d); err == nil {
			state.Deliveries[key] = d
		} else if err != ErrNotFound {
			return err
		}
	}
	if owner != "" {
		key := owner + "/" + id
		var at time.Time
		if err := s.getTx(tx, notificationReadKind, key, &at); err == nil {
			state.Reads[key] = at
		} else if err != ErrNotFound {
			return err
		}
	}
	return nil
}
func notificationOrder(at time.Time, id string) string {
	// Reverse chronological, stable event-ID order, fixed width for all instants.
	return fmt.Sprintf("%016x%08x/%s", ^(uint64(at.Unix()) ^ (uint64(1) << 63)), ^uint32(at.Nanosecond()), id)
}
func notificationInboxKind(e notifications.Event) string {
	if e.AdminOnly {
		return notificationInboxPrefix + "@admins"
	}
	return notificationInboxPrefix + e.RecipientID
}
func (s *Store) notificationIndexRefsTx(tx *sql.Tx, kind string, limit int) ([]string, error) {
	rows, err := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id LIMIT ?`, kind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			return nil, err
		}
		var ref string
		if err = s.open(kind, id, b, &ref); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}
func (s *Store) readNotificationInboxTx(tx *sql.Tx, state *notifications.State, kind string, r notifications.Recipient, now time.Time) error {
	// Keyset pages avoid buffering the recipient's retained history. Ineligible
	// old items are skipped without truncating eligible items behind them.
	cursor := ""
	accepted := 0
	for accepted < 200 {
		rows, err := tx.Query(`SELECT id,data FROM records WHERE kind=? AND id>? ORDER BY id LIMIT 128`, kind, cursor)
		if err != nil {
			return err
		}
		refs := []string{}
		for rows.Next() {
			var b []byte
			if err = rows.Scan(&cursor, &b); err != nil {
				break
			}
			var ref string
			if err = s.open(kind, cursor, b, &ref); err != nil {
				break
			}
			refs = append(refs, ref)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if len(refs) == 0 {
			return nil
		}
		for _, ref := range refs {
			single := notifications.DefaultState()
			if err = s.loadNotificationEventTx(tx, &single, ref, r.ID); err != nil {
				return err
			}
			event, exists := single.Events[ref]
			if !exists {
				return fmt.Errorf("inconsistent notification inbox index")
			}
			d := single.Deliveries[ref+"/in-app"]
			if d.Status != "available" || !notifications.Visible(single, event, r, now) {
				continue
			}
			if a, ok := single.Announcements[event.AnnouncementID]; ok {
				state.Announcements[event.AnnouncementID] = a
			}
			state.Events[ref] = event
			state.Deliveries[ref+"/in-app"] = d
			if at, ok := single.Reads[r.ID+"/"+ref]; ok {
				state.Reads[r.ID+"/"+ref] = at
			}
			accepted++
			if accepted == 200 {
				break
			}
		}
	}
	return nil
}
func (s *Store) writeNotificationChangesTx(tx *sql.Tx, before, after notifications.State) error {
	oldConfig := notificationConfig{1, before.Settings, before.Secrets}
	newConfig := notificationConfig{1, after.Settings, after.Secrets}
	a, _ := json.Marshal(oldConfig)
	b, _ := json.Marshal(newConfig)
	var saved notificationConfig
	configErr := s.getTx(tx, notificationConfigKind, "settings", &saved)
	if configErr != nil && configErr != ErrNotFound {
		return configErr
	}
	if !bytes.Equal(a, b) || configErr == ErrNotFound {
		if err := s.putTx(tx, notificationConfigKind, "settings", newConfig); err != nil {
			return err
		}
	}
	if err := writeNotificationMap(s, tx, notificationAnnouncementKind, before.Announcements, after.Announcements, nil); err != nil {
		return err
	}
	if err := writeNotificationMap(s, tx, notificationReadKind, before.Reads, after.Reads, nil); err != nil {
		return err
	}
	if err := writeNotificationMap(s, tx, notificationEventKind, before.Events, after.Events, func(id string, old, next *notifications.Event) error {
		if old != nil {
			if _, err := s.deleteTx(tx, notificationInboxKind(*old), notificationOrder(old.CreatedAt, id)); err != nil {
				return err
			}
		}
		if next != nil {
			return s.putTx(tx, notificationInboxKind(*next), notificationOrder(next.CreatedAt, id), id)
		}
		return nil
	}); err != nil {
		return err
	}
	return writeNotificationMap(s, tx, notificationDeliveryKind, before.Deliveries, after.Deliveries, func(id string, old, next *notifications.Delivery) error {
		if old != nil {
			if _, err := s.deleteTx(tx, notificationHistoryKind, notificationOrder(old.CreatedAt, id)); err != nil {
				return err
			}
		}
		if _, err := s.deleteTx(tx, notificationPendingKind, id); err != nil {
			return err
		}
		if next != nil {
			if err := s.putTx(tx, notificationHistoryKind, notificationOrder(next.CreatedAt, id), id); err != nil {
				return err
			}
			if next.Status == "queued" || next.Status == "retrying" || next.Status == "sending" {
				return s.putTx(tx, notificationPendingKind, id, *next)
			}
		}
		return nil
	})
}
func writeNotificationMap[T any](s *Store, tx *sql.Tx, kind string, before, after map[string]T, index func(string, *T, *T) error) error {
	for id, next := range after {
		old, exists := before[id]
		a, _ := json.Marshal(old)
		b, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if exists && bytes.Equal(a, b) {
			continue
		}
		if len(b) > 32<<20 {
			return fmt.Errorf("notification record exceeds backup-compatible record limit")
		}
		if err = s.putTx(tx, kind, id, next); err != nil {
			return err
		}
		if index != nil {
			var previous *T
			if exists {
				previous = &old
			}
			if err = index(id, previous, &next); err != nil {
				return err
			}
		}
	}
	for id, old := range before {
		if _, exists := after[id]; exists {
			continue
		}
		if _, err := s.deleteTx(tx, kind, id); err != nil {
			return err
		}
		if index != nil {
			if err := index(id, &old, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
