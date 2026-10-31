package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"time"
)

func (h *server) notificationService() *notifications.Service { return notifications.New(h.s, nil) }
func notificationRecipient(r *http.Request) notifications.Recipient {
	p := current(r)
	return notifications.Recipient{ID: p.Account.ID, Role: p.Account.Role, Enabled: !p.Account.Disabled}
}
func notificationError(w http.ResponseWriter, e error) {
	if errors.Is(e, notifications.ErrNotFound) {
		fail(w, 404, "notification not found")
	} else if errors.Is(e, notifications.ErrConflict) {
		fail(w, 409, e.Error())
	} else {
		fail(w, 400, e.Error())
	}
}

// notificationInputs uses the same authoritative usage/cycle computation as the
// user's overview. Provider allowance is not inferred from these traffic meters.
func (h *server) notificationInputs(now time.Time) ([]notifications.Recipient, []notifications.UserSnapshot, error) {
	state, e := h.s.State()
	if e != nil {
		return nil, nil, e
	}
	raw, e := h.s.List("accounts")
	if e != nil {
		return nil, nil, e
	}
	accounts := map[string]store.Account{}
	for _, b := range raw {
		var a store.Account
		if e = json.Unmarshal(b, &a); e != nil {
			return nil, nil, e
		}
		accounts[a.ID] = a
	}
	recipients := []notifications.Recipient{{ID: "operator", Role: "admin", Enabled: true}}
	users := []notifications.UserSnapshot{}
	for _, u := range state.Users {
		role := "user"
		enabled := u.Enabled
		if a, ok := accounts[u.ID]; ok {
			role = a.Role
			enabled = enabled && !a.Disabled
		}
		recipients = append(recipients, notifications.Recipient{ID: u.ID, Role: role, Enabled: enabled})
		if !enabled {
			continue
		}
		o, e := h.overview(u.ID, now)
		if e != nil {
			return nil, nil, e
		}
		users = append(users, notifications.UserSnapshot{UserID: u.ID, Enabled: enabled, QuotaBytes: o.QuotaBytes, UsedBytes: o.Usage.WeightedBytes, CycleID: o.Cycle.Start.UTC().Format(time.RFC3339Nano), ExpiresAt: o.Entitlement.ExpiresAt})
	}
	return recipients, users, nil
}
func (h *server) refreshInApp(ctx context.Context, now time.Time) error {
	recipients, users, e := h.notificationInputs(now)
	if e != nil {
		return e
	}
	n := h.notificationService()
	if e = n.Evaluate(recipients, users, now); e != nil {
		return e
	}
	if e = h.evaluateProviderAllowances(now); e != nil {
		return e
	}
	return n.DeliverInApp(ctx, recipients, time.Now().UTC())
}
func (h *server) registerNotifications(r chi.Router) {
	r.Get("/me/notifications", func(w http.ResponseWriter, r *http.Request) {
		now := time.Now().UTC()
		if e := h.refreshInApp(r.Context(), now); e != nil {
			fail(w, 500, "cannot refresh notification inbox")
			return
		}
		v, e := h.notificationService().Inbox(notificationRecipient(r), now)
		if e != nil {
			fail(w, 500, "cannot read notification inbox")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/me/notifications/{id}/read", func(w http.ResponseWriter, r *http.Request) {
		if e := h.notificationService().MarkRead(notificationRecipient(r), chi.URLParam(r, "id"), time.Now().UTC()); e != nil {
			notificationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
}
func (h *server) registerNotificationAdmin(r chi.Router) {
	r.Get("/admin/announcements", func(w http.ResponseWriter, r *http.Request) {
		v, e := h.notificationService().Announcements()
		if e != nil {
			fail(w, 500, "cannot list announcements")
			return
		}
		writeJSON(w, 200, v)
	})
	save := func(w http.ResponseWriter, r *http.Request) {
		var in notifications.Announcement
		if !decode(w, r, &in) {
			return
		}
		if id := chi.URLParam(r, "id"); id != "" && id != in.ID {
			fail(w, 400, "announcement id mismatch")
			return
		}
		if in.Audience == "users" {
			st, e := h.s.State()
			if e != nil {
				fail(w, 500, "cannot check audience")
				return
			}
			known := map[string]bool{}
			for _, u := range st.Users {
				known[u.ID] = true
			}
			for _, id := range in.UserIDs {
				if !known[id] {
					fail(w, 400, "announcement audience contains an unknown user")
					return
				}
			}
		}
		if e := h.notificationService().SaveAnnouncement(in); e != nil {
			notificationError(w, e)
			return
		}
		if e := h.s.Audit(current(r).Account.ID, "announcement.saved", in.ID); e != nil {
			fail(w, 500, "announcement saved, but audit could not be recorded")
			return
		}
		writeJSON(w, 200, in)
	}
	r.Post("/admin/announcements", save)
	r.Put("/admin/announcements/{id}", save)
	r.Get("/admin/notification-settings", func(w http.ResponseWriter, r *http.Request) {
		v, e := h.notificationService().Settings()
		if e != nil {
			fail(w, 500, "cannot read notification settings")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Put("/admin/notification-settings", func(w http.ResponseWriter, r *http.Request) {
		var in notifications.SettingsInput
		if !decode(w, r, &in) {
			return
		}
		v, e := h.notificationService().SaveSettings(in)
		if e != nil {
			notificationError(w, e)
			return
		}
		if e = h.s.Audit(current(r).Account.ID, "notification-settings.saved", fmt.Sprintf("revision-%d", v.Revision)); e != nil {
			fail(w, 500, "settings saved, but audit could not be recorded")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Get("/admin/notifications/outbox", func(w http.ResponseWriter, r *http.Request) {
		v, e := h.notificationService().Outbox()
		if e != nil {
			fail(w, 500, "cannot read notification outbox")
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/admin/notifications/test", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Channel string `json:"channel"`
		}
		if !decode(w, r, &in) {
			return
		}
		n := h.notificationService()
		now := time.Now().UTC()
		recipient := notificationRecipient(r)
		eventID, e := n.Test(in.Channel, recipient, now)
		if e != nil {
			notificationError(w, e)
			return
		}
		if e = h.s.Audit(current(r).Account.ID, "notification.test-requested", eventID); e != nil {
			fail(w, 500, "test queued, but audit could not be recorded")
			return
		}
		if e = n.DispatchEvent(r.Context(), []notifications.Recipient{recipient}, time.Now().UTC(), eventID); e != nil {
			fail(w, 503, "test remains queued; check outbox status")
			return
		}
		outbox, e := n.Outbox()
		if e != nil {
			fail(w, 500, "test attempted; cannot read outbox status")
			return
		}
		for _, d := range outbox {
			if d.EventID == eventID {
				writeJSON(w, 200, d)
				return
			}
		}
		fail(w, 500, "test result could not be found")
	})
}

// RunNotifications is a blocking same-process worker. Its caller owns the
// goroutine and context. Cancellation stops future work, interrupted sends keep
// their durable state. A transient storage failure is reported, then retried on
// the next bounded tick. It never creates an external channel automatically.
func RunNotifications(ctx context.Context, s *store.Store, interval time.Duration, report func(error)) {
	if ctx.Err() != nil {
		return
	}
	if interval < time.Second {
		interval = time.Minute
	}
	h := &server{s: s}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	run := func() {
		now := time.Now().UTC()
		recipients, users, e := h.notificationInputs(now)
		if e == nil {
			e = h.notificationService().Evaluate(recipients, users, now)
		}
		if e == nil {
			e = h.evaluateProviderAllowances(now)
		}
		if e == nil {
			e = h.notificationService().Dispatch(ctx, recipients, time.Now().UTC())
		}
		if e != nil && ctx.Err() == nil && report != nil {
			report(errors.New("notification evaluation or dispatch failed"))
		}
	}
	run()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
