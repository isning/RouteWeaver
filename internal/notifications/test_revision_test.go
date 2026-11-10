package notifications_test

import (
	"context"
	"errors"
	"routeweaver/internal/notifications"
	"testing"
	"time"
)

func TestExplicitTestRejectsChangedReviewedSettingsBeforeEnqueue(t *testing.T) {
	db := repo(t)
	transport := &localDelivery{}
	s := notifications.New(db, transport)
	configuredWebhook(t, s)
	reviewed, err := s.Settings()
	if err != nil {
		t.Fatal(err)
	}
	changed := reviewed.Settings
	changed.Webhook.URL = "https://changed.example.com/events"
	saved, err := s.SaveSettings(notifications.SettingsInput{Settings: changed})
	if err != nil {
		t.Fatal(err)
	}
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	now := time.Now().UTC()
	id, err := s.TestWithSettingsRevision("webhook", admin, now, &reviewed.Revision)
	if !errors.Is(err, notifications.ErrConflict) || id != "" {
		t.Fatalf("stale decision accepted: %q %v", id, err)
	}
	state, err := db.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Events) != 0 || len(state.Deliveries) != 0 {
		t.Fatalf("rejected decision persisted work: %+v", state)
	}
	if err := s.Dispatch(context.Background(), []notifications.Recipient{admin}, now); err != nil {
		t.Fatal(err)
	}
	if len(transport.events) != 0 {
		t.Fatal("rejected decision sent a notification")
	}
	id, err = s.TestWithSettingsRevision("webhook", admin, now, &saved.Revision)
	if err != nil || id == "" {
		t.Fatalf("current review rejected: %q %v", id, err)
	}
	if err := s.Dispatch(context.Background(), []notifications.Recipient{admin}, now); err != nil {
		t.Fatal(err)
	}
	if len(transport.events) != 1 {
		t.Fatalf("expected one mock delivery, got %d", len(transport.events))
	}
	// Legacy callers deliberately request the current saved settings.
	if _, err := s.Test("webhook", admin, now); err != nil {
		t.Fatal(err)
	}
	// In-app tests have no external destination to bind.
	if _, err := s.TestWithSettingsRevision("in-app", admin, now, &reviewed.Revision); err != nil {
		t.Fatal(err)
	}
}
