package notifications

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

func (s *Service) Settings() (SettingsView, error) {
	st, e := s.read(Scope{})
	if e != nil {
		return SettingsView{}, e
	}
	return settingsView(st), nil
}
func settingsView(st State) SettingsView {
	return SettingsView{Settings: st.Settings, SMTPPasswordSet: st.Secrets.SMTPPassword != "", WebhookSecretSet: st.Secrets.WebhookSecret != ""}
}
func (s *Service) SaveSettings(in SettingsInput) (SettingsView, error) {
	var out SettingsView
	err := s.update(Scope{}, func(st *State) error {
		if in.Revision != st.Settings.Revision {
			return ErrConflict
		}
		secret := st.Secrets
		if in.SMTPPassword != nil {
			secret.SMTPPassword = *in.SMTPPassword
		}
		if in.WebhookSecret != nil {
			secret.WebhookSecret = *in.WebhookSecret
		}
		if e := validateSettings(in.Settings, secret); e != nil {
			return e
		}
		st.Settings = in.Settings
		st.Settings.Revision++
		st.Secrets = secret
		out = settingsView(*st)
		return nil
	})
	return out, err
}
func (s *Service) SaveAnnouncement(a Announcement) error {
	if e := validateAnnouncement(a); e != nil {
		return e
	}
	return s.update(Scope{}, func(st *State) error { st.Announcements[a.ID] = a; return nil })
}
func (s *Service) Announcements() ([]Announcement, error) {
	st, e := s.read(Scope{Announcements: true})
	if e != nil {
		return nil, e
	}
	out := []Announcement{}
	for _, a := range st.Announcements {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
func enqueue(st *State, e Event, channels []string, explicit bool) {
	if _, ok := st.Events[e.EventID]; ok {
		// An operator may restore the audience of an unpublished/cancelled in-app
		// notice. Reuse its identity/read receipt; never replay external delivery.
		if e.AnnouncementID != "" {
			k := deliveryKey(e.EventID, "in-app")
			d, exists := st.Deliveries[k]
			if exists && d.Status == "cancelled" {
				d.Status = "queued"
				d.Attempts = 0
				d.NextAttemptAt = e.CreatedAt
				d.LastError = ""
				st.Deliveries[k] = d
			}
		}
		return
	}
	st.Events[e.EventID] = e
	for _, channel := range channels {
		st.Deliveries[deliveryKey(e.EventID, channel)] = Delivery{EventID: e.EventID, Channel: channel, Status: "queued", NextAttemptAt: e.CreatedAt, CreatedAt: e.CreatedAt, SettingsRevision: st.Settings.Revision, Explicit: explicit}
	}
}
func reminderChannels(st *State, operator bool) []string {
	channels := []string{}
	if st.Settings.InApp {
		channels = append(channels, "in-app")
	}
	// Account reminders stay in the owner's inbox. External destinations are
	// explicit operator endpoints, never assumed to be a user's email address.
	if operator && st.Settings.Email.Enabled && st.Settings.Email.Automatic {
		channels = append(channels, "email")
	}
	if operator && st.Settings.Webhook.Enabled && st.Settings.Webhook.Automatic {
		channels = append(channels, "webhook")
	}
	return channels
}

// Evaluate uses server-derived snapshots. A stable cycle ID prevents a repeated
// evaluation or process restart from duplicating a threshold notification.
func (s *Service) Evaluate(recipients []Recipient, users []UserSnapshot, now time.Time) error {
	change := func(st *State) error {
		for _, a := range st.Announcements {
			for _, r := range recipients {
				if eligible(a, r, now) {
					expiry := a.ExpiresAt
					enqueue(st, Event{EventID: key("announcement", a.ID, r.ID), Kind: "announcement", RecipientID: r.ID, Title: a.Title, Body: a.Body, CreatedAt: a.StartsAt, ExpiresAt: &expiry, AnnouncementID: a.ID}, []string{"in-app"}, false)
				}
			}
		}
		enabled := map[string]bool{}
		for _, r := range recipients {
			enabled[r.ID] = r.Enabled
		}
		for _, u := range users {
			if !u.Enabled || !enabled[u.UserID] || u.CycleID == "" || u.UsedBytes < 0 || u.QuotaBytes < 0 {
				continue
			}
			channels := reminderChannels(st, false)
			if len(channels) == 0 {
				continue
			}
			if u.QuotaBytes > 0 {
				for _, threshold := range st.Settings.QuotaPercent {
					// Split arithmetic preserves exact byte boundaries without overflow.
					if u.UsedBytes >= percentCeiling(u.QuotaBytes, threshold) {
						enqueue(st, Event{EventID: key("quota", u.UserID, u.CycleID, threshold), Kind: "quota", RecipientID: u.UserID, Title: "Usage reminder", Body: fmt.Sprintf("Your usage has reached %d%% of the allowance for this cycle.", threshold), CreatedAt: now}, channels, false)
					}
				}
			}
			if u.ExpiresAt != nil && now.Before(*u.ExpiresAt) {
				for _, hours := range st.Settings.ExpiryHours {
					if u.ExpiresAt.Sub(now) <= time.Duration(hours)*time.Hour {
						// Repeat buckets are anchored to expiry, rather than wall-clock midnight.
						bucket := int64(u.ExpiresAt.Sub(now) / (time.Duration(st.Settings.RepeatHours) * time.Hour))
						enqueue(st, Event{EventID: key("expiry", u.UserID, u.ExpiresAt.UTC(), hours, bucket), Kind: "expiry", RecipientID: u.UserID, Title: "Service expiry reminder", Body: fmt.Sprintf("Your service expires within %d hours.", hours), CreatedAt: now, ExpiresAt: u.ExpiresAt}, channels, false)
					}
				}
			}
		}
		return nil
	}
	return s.update(Scope{Announcements: true, SelectEventIDs: selectNotificationEvents(change)}, change)
}

// EvaluateProvider only accepts fresh, explicit inventory observations. It is
// not wired to tenant traffic meters, which are not a provider billing source.
func (s *Service) EvaluateProvider(p ProviderSnapshot, now time.Time) error {
	if p.ID == "" || p.CycleID == "" || p.ObservedAt.IsZero() || p.ObservedAt.After(now.Add(time.Minute)) || now.Sub(p.ObservedAt) > 15*time.Minute || p.TotalBytes <= 0 || p.RemainingBytes < 0 || p.RemainingBytes > p.TotalBytes {
		return fmt.Errorf("fresh provider allowance observation required")
	}
	source := "recorded allowance"
	switch p.Source {
	case "nic_estimate":
		source = "NIC estimate, operator-reconciled"
	case "provider_statement":
		source = "operator-entered provider statement"
	case "":
	default:
		return fmt.Errorf("unknown provider allowance source")
	}
	change := func(st *State) error {
		channels := reminderChannels(st, true)
		if len(channels) == 0 {
			return nil
		}
		for _, percent := range st.Settings.ProviderRemainingPercent {
			if p.RemainingBytes <= percentFloor(p.TotalBytes, percent) {
				enqueue(st, Event{EventID: key("provider-quota", p.ID, p.CycleID, percent), Kind: "provider-quota", AdminOnly: true, Title: "Provider allowance reminder", Body: fmt.Sprintf("Provider resource %s has at most %d%% of its recorded allowance remaining (%s).", p.ID, percent, source), CreatedAt: now}, channels, false)
			}
		}
		if p.ExpiresAt != nil && now.Before(*p.ExpiresAt) {
			for _, hours := range st.Settings.ExpiryHours {
				if p.ExpiresAt.Sub(now) <= time.Duration(hours)*time.Hour {
					bucket := int64(p.ExpiresAt.Sub(now) / (time.Duration(st.Settings.RepeatHours) * time.Hour))
					enqueue(st, Event{EventID: key("provider-expiry", p.ID, p.ExpiresAt.UTC(), hours, bucket), Kind: "provider-expiry", AdminOnly: true, Title: "Provider expiry reminder", Body: fmt.Sprintf("Provider resource %s expires within %d hours.", p.ID, hours), CreatedAt: now, ExpiresAt: p.ExpiresAt}, channels, false)
				}
			}
		}
		return nil
	}
	return s.update(Scope{Announcements: false, SelectEventIDs: selectNotificationEvents(change)}, change)
}
func visible(st State, e Event, r Recipient, now time.Time) bool {
	if !r.Enabled || e.AdminOnly && r.Role != "admin" || !e.AdminOnly && e.RecipientID != r.ID {
		return false
	}
	if e.AnnouncementID != "" {
		a, ok := st.Announcements[e.AnnouncementID]
		return ok && eligible(a, r, now)
	}
	return e.ExpiresAt == nil || now.Before(*e.ExpiresAt)
}
func (s *Service) Inbox(r Recipient, now time.Time) ([]InboxItem, error) {
	st, e := s.read(Scope{Inbox: &r, InboxAt: now})
	if e != nil {
		return nil, e
	}
	out := []InboxItem{}
	for _, event := range st.Events {
		d, ok := st.Deliveries[deliveryKey(event.EventID, "in-app")]
		if !ok || d.Status != "available" || !visible(st, event, r, now) {
			continue
		}
		if event.AnnouncementID != "" {
			a := st.Announcements[event.AnnouncementID]
			event.Title = a.Title
			event.Body = a.Body
			expiry := a.ExpiresAt
			event.ExpiresAt = &expiry
		}
		item := InboxItem{Event: event}
		if read, ok := st.Reads[r.ID+"/"+event.EventID]; ok {
			item.ReadAt = &read
		}
		out = append(out, item)
	}
	sortedEvents(out)
	if len(out) > 200 {
		out = out[:200]
	}
	return out, nil
}
func (s *Service) MarkRead(r Recipient, eventID string, now time.Time) error {
	return s.update(Scope{EventIDs: []string{eventID}, ReceiptOwner: r.ID}, func(st *State) error {
		event, ok := st.Events[eventID]
		d := st.Deliveries[deliveryKey(eventID, "in-app")]
		if !ok || d.Status != "available" || !visible(*st, event, r, now) {
			return ErrNotFound
		}
		readKey := r.ID + "/" + eventID
		if _, ok := st.Reads[readKey]; !ok {
			st.Reads[readKey] = now
		}
		return nil
	})
}
func (s *Service) Outbox() ([]OutboxItem, error) {
	st, e := s.read(Scope{History: true})
	if e != nil {
		return nil, e
	}
	out := []OutboxItem{}
	for _, d := range st.Deliveries {
		event := st.Events[d.EventID]
		out = append(out, OutboxItem{EventID: d.EventID, Channel: d.Channel, Status: d.Status, Attempts: d.Attempts, NextAttemptAt: d.NextAttemptAt, LastError: d.LastError, CreatedAt: d.CreatedAt, Kind: event.Kind, Title: event.Title})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].EventID+out[i].Channel < out[j].EventID+out[j].Channel
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if len(out) > 500 {
		out = out[:500]
	}
	return out, nil
}

// Test records explicit permission for exactly this event/channel. Saving
// settings alone never performs this operation or grants automatic delivery.
func (s *Service) Test(channel string, r Recipient, now time.Time) (string, error) {
	if r.Role != "admin" || !r.Enabled {
		return "", fmt.Errorf("administrator required")
	}
	idBytes := make([]byte, 16)
	if _, e := rand.Read(idBytes); e != nil {
		return "", e
	}
	id := hex.EncodeToString(idBytes)
	err := s.update(Scope{EventIDs: []string{id}}, func(st *State) error {
		if channel != "in-app" && channel != "email" && channel != "webhook" {
			return fmt.Errorf("unsupported channel")
		}
		if channel == "email" && !st.Settings.Email.Enabled || channel == "webhook" && !st.Settings.Webhook.Enabled {
			return fmt.Errorf("channel must be configured and enabled before an explicit test")
		}
		enqueue(st, Event{EventID: id, Kind: "test", RecipientID: r.ID, Title: "RouteWeaver notification test", Body: "This is an explicitly requested notification-channel test.", CreatedAt: now}, []string{channel}, true)
		return nil
	})
	return id, err
}

// Dispatch resumes durable queued/retrying/expired-lease work. The same eventId
// is retained after crashes and retries. Receiver idempotency is necessary:
// acceptance followed by a lost response can produce another delivery attempt.
func (s *Service) Dispatch(ctx context.Context, recipients []Recipient, now time.Time) error {
	return s.dispatch(ctx, recipients, now, "", "")
}
func (s *Service) DispatchEvent(ctx context.Context, recipients []Recipient, now time.Time, eventID string) error {
	return s.dispatch(ctx, recipients, now, eventID, "")
}
func (s *Service) DeliverInApp(ctx context.Context, recipients []Recipient, now time.Time) error {
	return s.dispatch(ctx, recipients, now, "", "in-app")
}
func (s *Service) dispatch(ctx context.Context, recipients []Recipient, now time.Time, eventID, onlyChannel string) error {
	started := time.Now()
	return s.dispatchWithClock(ctx, recipients, func() time.Time {
		return now.Add(time.Since(started))
	}, eventID, onlyChannel)
}

// dispatchWithClock keeps time as an internal system seam. Callers supply the
// initial logical time; production advances it monotonically during transport I/O.
func (s *Service) dispatchWithClock(ctx context.Context, recipients []Recipient, clock func() time.Time, eventID, onlyChannel string) error {
	for n := 0; n < 100; n++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		var delivery Delivery
		var event Event
		var config Settings
		var secrets Secrets
		claimed := false
		progressed := false
		claimAt := clock()
		err := s.update(Scope{PendingAt: &claimAt, PendingEventID: eventID, OnlyChannel: onlyChannel}, func(st *State) error {
			keys := make([]string, 0, len(st.Deliveries))
			for k := range st.Deliveries {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				d := st.Deliveries[k]
				if onlyChannel != "" && d.Channel != onlyChannel {
					continue
				}
				if eventID != "" && d.EventID != eventID {
					continue
				}
				if d.Status != "queued" && d.Status != "retrying" && d.Status != "sending" {
					continue
				}
				now := clock()
				if d.Status == "sending" && now.Before(d.LeaseUntil) || now.Before(d.NextAttemptAt) {
					continue
				}
				ev, ok := st.Events[d.EventID]
				allowed := false
				for _, r := range recipients {
					if visible(*st, ev, r, now) {
						allowed = true
						break
					}
				}
				if !ok || !allowed {
					d.Status = "cancelled"
					d.LastError = "recipient or validity is no longer eligible"
					st.Deliveries[k] = d
					progressed = true
					continue
				}
				if d.Channel != "in-app" {
					enabled := d.Channel == "email" && st.Settings.Email.Enabled && (d.Explicit || st.Settings.Email.Automatic) || d.Channel == "webhook" && st.Settings.Webhook.Enabled && (d.Explicit || st.Settings.Webhook.Automatic)
					if !enabled || d.SettingsRevision != st.Settings.Revision {
						d.Status = "cancelled"
						d.LastError = "channel settings or authorization changed; create a new explicit test"
						st.Deliveries[k] = d
						progressed = true
						continue
					}
				}
				if d.Attempts >= MaxAttempts {
					d.Status = "failed"
					d.LastError = "delivery attempts exhausted; receiver acceptance may be unknown"
					st.Deliveries[k] = d
					progressed = true
					continue
				}
				nonce := make([]byte, 16)
				if _, e := rand.Read(nonce); e != nil {
					return e
				}
				d.Attempts++
				d.Status = "sending"
				d.LeaseUntil = now.Add(time.Minute)
				d.LeaseToken = hex.EncodeToString(nonce)
				st.Deliveries[k] = d
				delivery = d
				event = ev
				config = st.Settings
				secrets = st.Secrets
				claimed = true
				break
			}
			return nil
		})
		if err != nil {
			return err
		}
		if !claimed {
			if progressed {
				continue
			}
			return nil
		}
		var sendErr error
		if delivery.Channel != "in-app" {
			sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			sendErr = s.transport.Send(sendCtx, delivery.Channel, event, config, secrets)
			cancel()
		}
		err = s.update(Scope{EventIDs: []string{delivery.EventID}}, func(st *State) error {
			k := deliveryKey(delivery.EventID, delivery.Channel)
			d, ok := st.Deliveries[k]
			if !ok || d.LeaseToken != delivery.LeaseToken {
				return nil
			}
			d.LeaseUntil = time.Time{}
			d.LeaseToken = ""
			if sendErr == nil {
				d.Status = "accepted"
				if d.Channel == "in-app" {
					d.Status = "available"
				}
				d.LastError = ""
			} else {
				// Adapter errors can contain credentials and destinations; persist only
				// bounded, actionable classification, never raw transport strings.
				d.LastError = "channel delivery failed; verify destination, credentials and TLS, then test again"
				d.Status = "retrying"
				d.NextAttemptAt = clock().Add(time.Duration(1<<uint(d.Attempts-1)) * time.Minute)
				if d.Attempts >= MaxAttempts {
					d.Status = "failed"
				}
			}
			st.Deliveries[k] = d
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func percentFloor(total int64, percent int) int64 {
	return total/100*int64(percent) + (total%100)*int64(percent)/100
}
func percentCeiling(total int64, percent int) int64 {
	return total/100*int64(percent) + ((total%100)*int64(percent)+99)/100
}
