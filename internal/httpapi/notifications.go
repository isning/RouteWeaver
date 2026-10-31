package httpapi

import (
	"context"
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

func (h *server) registerNotifications(r chi.Router) {
	r.Get("/me/notifications", func(w http.ResponseWriter, r *http.Request) {
		now := time.Now().UTC()
		v, e := h.notificationService().InboxContext(r.Context(), notificationRecipient(r), now)
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

// RunNotificationBatch advances one keyset page. Evaluation failure does not
// suppress already-durable delivery, and dispatch uses the COMPLETE current
// audience rather than accidentally cancelling recipients outside this page.
func RunNotificationBatch(ctx context.Context, s *store.Store, after string, now time.Time) (string, error) {
	return runNotificationBatchWithBudget(ctx, s, after, now, 5*time.Second, store.DefaultNotificationColdBudget())
}

func runNotificationBatch(ctx context.Context, s *store.Store, after string, now time.Time, evaluationBudget time.Duration) (string, error) {
	return runNotificationBatchWithBudget(ctx, s, after, now, evaluationBudget, store.DefaultNotificationColdBudget())
}
func runNotificationBatchWithBudget(ctx context.Context, s *store.Store, after string, now time.Time, evaluationBudget time.Duration, budget store.NotificationColdBudget) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	evaluationCtx, finishEvaluation := context.WithTimeout(ctx, evaluationBudget)
	defer finishEvaluation()
	started := time.Now()
	inputCtx, finishInput := context.WithTimeout(evaluationCtx, 2*time.Second)
	page, inputErr := s.NotificationInputPageWithBudget(inputCtx, after, store.NotificationPageSize, now, budget)
	inputErr = errors.Join(inputErr, inputCtx.Err())
	finishInput()
	if errors.Is(inputErr, context.DeadlineExceeded) && evaluationCtx.Err() == nil {
		// A slow host can make the maximum page impossible to commit. Retry a
		// smaller atomic input page inside the same evaluation budget; successful
		// keyset advancement reflects only that committed page, never skipped IDs.
		page, inputErr = s.NotificationInputPageWithBudget(evaluationCtx, after, 10, now, budget)
	}
	h := &server{s: s}
	n := h.notificationService()
	// Usage-bearing snapshots require a committed projection transaction. A cold
	// refusal can also return explicitly usage-unknown policy/expiry snapshots.
	users := page.Users
	next, evaluateErr := evaluateNotificationRecipients(evaluationCtx, page.Recipients, users, after, page.Next, now, n.EvaluateContext)

	var providerErr error
	if after == "" && evaluationCtx.Err() == nil {
		providerErr = h.evaluateProviderAllowancesContext(evaluationCtx, now)
	}
	evaluateErr = errors.Join(evaluateErr, evaluationCtx.Err())
	finishEvaluation()
	recipients, recipientErr := s.NotificationRecipients(ctx)
	var dispatchErr error
	if recipientErr == nil {
		dispatchErr = n.DispatchBounded(ctx, recipients, now.Add(time.Since(started)), 1000)
	}
	return next, errors.Join(inputErr, evaluateErr, providerErr, recipientErr, dispatchErr)
}

// Partial enqueue must resume after the last committed user, not after the
// entire input page: otherwise a repeatedly expensive prefix can starve its tail.
func evaluateNotificationRecipients(ctx context.Context, recipients []notifications.Recipient, users []notifications.UserSnapshot, after, pageNext string, now time.Time, evaluate func(context.Context, []notifications.Recipient, []notifications.UserSnapshot, time.Time) error) (string, error) {
	completed := after
	for offset := 0; offset < len(recipients); offset += 10 {
		end := offset + 10
		if end > len(recipients) {
			end = len(recipients)
		}
		chunk := recipients[offset:end]
		if err := evaluate(ctx, chunk, users, now); err != nil {
			return completed, err
		}
		for _, recipient := range chunk {
			if !(recipient.ID == "operator" && recipient.Role == "admin") {
				completed = recipient.ID
			}
		}
	}
	return pageNext, nil
}

// RunNotifications is the same-process bounded worker. One current-user page
// per tick gives a finite full-sweep delay; restarting at page zero is safe
// because event identities and dedupe facts are durable. No network broker.
func RunNotifications(ctx context.Context, s *store.Store, interval time.Duration, report func(error)) {
	RunNotificationsWithBudget(ctx, s, interval, store.DefaultNotificationColdBudget(), report)
}
func RunNotificationsWithBudget(ctx context.Context, s *store.Store, interval time.Duration, budget store.NotificationColdBudget, report func(error)) {
	if err := budget.Validate(); err != nil {
		if report != nil {
			report(err)
		}
		return
	}
	if ctx.Err() != nil {
		return
	}
	if interval < time.Second {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	after := ""
	run := func() {
		next, err := runNotificationBatchWithBudget(ctx, s, after, time.Now().UTC(), 5*time.Second, budget)
		after = next
		if err != nil && ctx.Err() == nil && report != nil {
			switch {
			case errors.Is(err, store.ErrNotificationColdBudget):
				report(errors.New("notification quota cold rebuild exceeds the background budget; retained outbox processing continues; review notification maintenance guidance"))
			case errors.Is(err, context.DeadlineExceeded):
				report(errors.New("notification batch reached its time budget; durable partial progress is retained for later ticks"))
			default:
				report(errors.New("notification evaluation or dispatch failed; retained facts were not discarded"))
			}
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
