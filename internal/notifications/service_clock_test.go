package notifications_test

import (
	"context"
	"errors"
	"routeweaver/internal/notifications"
	"testing"
	"time"
)

type clockDelivery func(context.Context, string, notifications.Event, notifications.Settings, notifications.Secrets) error

func (f clockDelivery) Send(ctx context.Context, channel string, event notifications.Event, settings notifications.Settings, secrets notifications.Secrets) error {
	return f(ctx, channel, event, settings, secrets)
}

func TestBatchClaimsFreshLeaseAfterSlowEarlierSend(t *testing.T) {
	db := repo(t)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	calls := 0
	transport := clockDelivery(func(_ context.Context, _ string, e notifications.Event, _ notifications.Settings, _ notifications.Secrets) error {
		calls++
		if calls <= 5 {
			now = now.Add(13 * time.Second)
			return nil
		}
		state, err := db.ReadNotifications()
		if err != nil {
			t.Fatal(err)
		}
		lease := state.Deliveries[e.EventID+"/webhook"].LeaseUntil
		want := time.Date(2026, 10, 19, 12, 2, 5, 0, time.UTC)
		if !lease.Equal(want) {
			t.Errorf("newly claimed event lease = %v, want %v", lease, want)
		}
		return nil
	})
	s := notifications.New(db, transport)
	configuredWebhook(t, s)
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	for i := 0; i < 6; i++ {
		if _, err := s.Test("webhook", admin, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := notifications.DispatchWithClockForTest(s, context.Background(), []notifications.Recipient{admin}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	out, err := s.Outbox()
	if err != nil || len(out) != 6 {
		t.Fatalf("outbox: %v %v", out, err)
	}
	for _, d := range out {
		if d.Status != "accepted" || d.Attempts != 1 {
			t.Fatalf("unexpected result: %+v", d)
		}
	}
}

func TestRetryDelayStartsAfterTransportFailure(t *testing.T) {
	db := repo(t)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	calls := 0
	transport := clockDelivery(func(context.Context, string, notifications.Event, notifications.Settings, notifications.Secrets) error {
		calls++
		if calls == 1 {
			now = now.Add(20 * time.Second)
			return errors.New("synthetic rejected send")
		}
		return nil
	})
	s := notifications.New(db, transport)
	configuredWebhook(t, s)
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	if _, err := s.Test("webhook", admin, now); err != nil {
		t.Fatal(err)
	}
	dispatch := func() {
		t.Helper()
		if err := notifications.DispatchWithClockForTest(s, context.Background(), []notifications.Recipient{admin}, func() time.Time { return now }); err != nil {
			t.Fatal(err)
		}
	}
	dispatch()
	out, err := s.Outbox()
	if err != nil || len(out) != 1 {
		t.Fatalf("outbox: %v %v", out, err)
	}
	want := time.Date(2026, 10, 19, 12, 1, 20, 0, time.UTC)
	if !out[0].NextAttemptAt.Equal(want) {
		t.Errorf("retry due = %v, want %v", out[0].NextAttemptAt, want)
	}
	now = time.Date(2026, 10, 19, 12, 1, 0, 0, time.UTC)
	dispatch()
	if calls != 1 {
		t.Errorf("retry ran before full post-failure delay: %d sends", calls)
	}
	now = want
	dispatch()
	out, err = s.Outbox()
	if err != nil || len(out) != 1 || out[0].Status != "accepted" || out[0].Attempts != 2 {
		t.Fatalf("due retry: %v %v", out, err)
	}
}

func TestQueuedExpiryRecheckedAfterEarlierSend(t *testing.T) {
	db := repo(t)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	calls := 0
	transport := clockDelivery(func(context.Context, string, notifications.Event, notifications.Settings, notifications.Secrets) error {
		calls++
		now = now.Add(13 * time.Second)
		return nil
	})
	s := notifications.New(db, transport)
	configuredWebhook(t, s)
	settings, err := s.Settings()
	if err != nil {
		t.Fatal(err)
	}
	settings.InApp = false
	settings.Webhook.Automatic = true
	settings.ExpiryHours = []int{1}
	settings.ProviderRemainingPercent = nil
	if _, err = s.SaveSettings(notifications.SettingsInput{Settings: settings.Settings}); err != nil {
		t.Fatal(err)
	}
	expires := now.Add(10 * time.Second)
	for _, id := range []string{"provider-a", "provider-b"} {
		if err = s.EvaluateProvider(notifications.ProviderSnapshot{ID: id, CycleID: "synthetic-cycle", RemainingBytes: 500, TotalBytes: 1000, ExpiresAt: &expires, ObservedAt: now}, now); err != nil {
			t.Fatal(err)
		}
	}
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	if err = notifications.DispatchWithClockForTest(s, context.Background(), []notifications.Recipient{admin}, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	out, err := s.Outbox()
	if err != nil || len(out) != 2 {
		t.Fatalf("outbox: %v %v", out, err)
	}
	counts := map[string]int{}
	for _, d := range out {
		counts[d.Status]++
	}
	if calls != 1 || counts["accepted"] != 1 || counts["cancelled"] != 1 {
		t.Fatalf("expired queued event sent: sends=%d statuses=%v", calls, counts)
	}
}
