package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"routeweaver/internal/notifications"
	"strings"
)

// Notification indexes are portable records, not disposable hints: accepting an
// incomplete set could hide retained deliveries after restore. Validate both
// directions while leaving unrelated/future opaque domain record kinds intact.
func validateNotificationBackupRecord(r BackupRecord, get func(string, string) (json.RawMessage, error)) error {
	if r.Kind == "notification-private" && r.ID == "state" {
		if _, err := get(notificationConfigKind, "settings"); err == nil {
			return fmt.Errorf("mixed legacy and current notification backup")
		} else if err != ErrNotFound {
			return err
		}
		_, err := decodeLegacyNotifications(r.Data)
		return err
	}
	known := r.Kind == notificationConfigKind || r.Kind == notificationEventKind || r.Kind == notificationDeliveryKind || r.Kind == notificationReadKind || r.Kind == notificationAnnouncementKind || r.Kind == notificationPendingKind || r.Kind == notificationHistoryKind || strings.HasPrefix(r.Kind, notificationInboxPrefix)
	if !known {
		return nil
	}
	bad := func() error { return fmt.Errorf("incomplete or inconsistent notification backup records") }
	if r.Kind == notificationConfigKind {
		var config notificationConfig
		if r.ID != "settings" || json.Unmarshal(r.Data, &config) != nil || config.Version != 1 {
			return bad()
		}
		return nil
	}
	config, err := get(notificationConfigKind, "settings")
	if err != nil {
		return bad()
	}
	var c notificationConfig
	if json.Unmarshal(config, &c) != nil || c.Version != 1 {
		return bad()
	}
	ref := func(kind, id, want string) error {
		raw, e := get(kind, id)
		if e != nil {
			return bad()
		}
		var actual string
		if json.Unmarshal(raw, &actual) != nil || actual != want {
			return bad()
		}
		return nil
	}
	switch {
	case r.Kind == notificationEventKind:
		var e notifications.Event
		if json.Unmarshal(r.Data, &e) != nil || e.EventID != r.ID {
			return bad()
		}
		return ref(notificationInboxKind(e), notificationOrder(e.CreatedAt, e.EventID), e.EventID)
	case r.Kind == notificationDeliveryKind:
		var d notifications.Delivery
		if json.Unmarshal(r.Data, &d) != nil || d.EventID+"/"+d.Channel != r.ID {
			return bad()
		}
		if _, err = get(notificationEventKind, d.EventID); err != nil {
			return bad()
		}
		if err = ref(notificationHistoryKind, notificationOrder(d.CreatedAt, r.ID), r.ID); err != nil {
			return err
		}
		pending, e := get(notificationPendingKind, r.ID)
		if d.Status == "queued" || d.Status == "retrying" || d.Status == "sending" {
			if e != nil || !bytes.Equal(pending, r.Data) {
				return bad()
			}
		} else if e == nil {
			return bad()
		} else if e != ErrNotFound {
			return e
		}
	case r.Kind == notificationPendingKind:
		canonical, e := get(notificationDeliveryKind, r.ID)
		if e != nil || !bytes.Equal(canonical, r.Data) {
			return bad()
		}
		var d notifications.Delivery
		if json.Unmarshal(r.Data, &d) != nil || d.Status != "queued" && d.Status != "retrying" && d.Status != "sending" {
			return bad()
		}
	case r.Kind == notificationHistoryKind:
		var id string
		if json.Unmarshal(r.Data, &id) != nil {
			return bad()
		}
		raw, e := get(notificationDeliveryKind, id)
		if e != nil {
			return bad()
		}
		var d notifications.Delivery
		if json.Unmarshal(raw, &d) != nil || r.ID != notificationOrder(d.CreatedAt, id) {
			return bad()
		}
	case strings.HasPrefix(r.Kind, notificationInboxPrefix):
		var id string
		if json.Unmarshal(r.Data, &id) != nil {
			return bad()
		}
		raw, err := get(notificationEventKind, id)
		if err != nil {
			return bad()
		}
		var e notifications.Event
		if json.Unmarshal(raw, &e) != nil || r.Kind != notificationInboxKind(e) || r.ID != notificationOrder(e.CreatedAt, id) {
			return bad()
		}
	}
	return nil
}
