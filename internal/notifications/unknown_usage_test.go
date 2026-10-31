package notifications_test

import (
	"routeweaver/internal/notifications"
	"testing"
	"time"
)

func TestUnknownUsageCannotTriggerQuotaButRetainsExpiry(t *testing.T) {
	r := repo(t)
	n := notifications.New(r, nil)
	now := time.Now().UTC()
	expiry := now.Add(time.Hour)
	if err := n.Evaluate([]notifications.Recipient{{ID: "alice", Role: "user", Enabled: true}}, []notifications.UserSnapshot{{UserID: "alice", Enabled: true, UsageUnknown: true, QuotaBytes: 1, UsedBytes: 999, CycleID: "cycle", ExpiresAt: &expiry}}, now); err != nil {
		t.Fatal(err)
	}
	state, err := r.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	expiryFound := false
	for _, event := range state.Events {
		if event.Kind == "quota" {
			t.Fatal("unknown usage triggered quota")
		}
		if event.Kind == "expiry" {
			expiryFound = true
		}
	}
	if !expiryFound {
		t.Fatal("usage uncertainty suppressed independent expiry")
	}
}
