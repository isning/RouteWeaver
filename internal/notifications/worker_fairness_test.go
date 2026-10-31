package notifications_test

import (
	"context"
	"errors"
	"routeweaver/internal/notifications"
	"testing"
	"time"
)

func TestBoundedWorkerSlowEmailDoesNotStarveInboxOrWebhook(t *testing.T) {
	db := repo(t)
	calls := map[string]int{}
	emailStarted := make(chan struct{})
	n := notifications.New(db, clockDelivery(func(ctx context.Context, channel string, event notifications.Event, settings notifications.Settings, secrets notifications.Secrets) error {
		calls[channel]++
		if channel == "email" {
			close(emailStarted)
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}))
	settings, err := n.Settings()
	if err != nil {
		t.Fatal(err)
	}
	settings.Email = notifications.EmailSettings{Enabled: true, Host: "smtp.example.com", Port: 587, TLSMode: "starttls", From: "operator@example.com", To: []string{"operator@example.com"}}
	settings.Webhook = notifications.WebhookSettings{Enabled: true, URL: "https://notify.example.com/events"}
	secret := "synthetic-webhook-signing-secret-long-enough"
	if _, err = n.SaveSettings(notifications.SettingsInput{Settings: settings.Settings, WebhookSecret: &secret}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	if err = db.UpdateNotifications(func(st *notifications.State) error {
		for id, channel := range map[string]string{"000-email": "email", "100-inbox": "in-app", "200-webhook": "webhook"} {
			st.Events[id] = notifications.Event{EventID: id, RecipientID: admin.ID, Title: "Synthetic worker fairness", CreatedAt: now}
			st.Deliveries[id+"/"+channel] = notifications.Delivery{EventID: id, Channel: channel, Status: "queued", CreatedAt: now, NextAttemptAt: now, SettingsRevision: st.Settings.Revision, Explicit: true}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- n.DispatchBounded(context.Background(), []notifications.Recipient{admin}, now, 1000) }()
	select {
	case <-emailStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("email fixture did not enter transport")
	}
	visible, e := n.Inbox(admin, time.Now().UTC())
	if e != nil || len(visible) != 1 {
		t.Fatalf("blocked email held back already available inbox: %+v %v", visible, e)
	}
	err = <-done
	t.Logf("bounded mixed-channel fixture duration=%s", time.Since(started))
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("slow email did not report its interrupted attempt: %v", err)
	}
	inbox, e := n.Inbox(admin, time.Now().UTC())
	if e != nil || len(inbox) != 1 {
		t.Fatalf("slow email starved personal inbox: %+v %v", inbox, e)
	}
	state, e := db.ReadNotifications()
	if e != nil {
		t.Fatal(e)
	}
	if state.Deliveries["200-webhook/webhook"].Status != "accepted" || calls["webhook"] != 1 {
		t.Fatalf("slow email starved independent webhook: %+v calls=%+v", state.Deliveries, calls)
	}
	if state.Deliveries["000-email/email"].Status == "accepted" || state.Deliveries["000-email/email"].Attempts != 1 {
		t.Fatalf("cancelled email falsely marked successful: %+v", state.Deliveries)
	}
	if err = n.DispatchBounded(context.Background(), []notifications.Recipient{admin}, time.Now().UTC(), 1000); err != nil {
		t.Fatal(err)
	}
	if calls["email"] != 1 || calls["webhook"] != 1 {
		t.Fatalf("partial progress or unexpired lease replayed: %+v", calls)
	}
}
