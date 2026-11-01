package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestNotificationEvaluationTimeoutReservesDurableDispatch(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{80}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	if err = s.PutUser(domain.User{ID: "recipient", Name: "Recipient", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateNotifications(func(st *notifications.State) error {
		st.Events["queued"] = notifications.Event{EventID: "queued", RecipientID: "recipient", Title: "Existing", CreatedAt: now}
		st.Deliveries["queued/in-app"] = notifications.Delivery{EventID: "queued", Channel: "in-app", Status: "queued", NextAttemptAt: now, CreatedAt: now}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = runNotificationBatch(context.Background(), s, "", now, time.Nanosecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("evaluation error=%v", err)
	}
	state, err := s.ReadNotificationsScope(notifications.Scope{EventIDs: []string{"queued"}})
	if err != nil {
		t.Fatal(err)
	}
	if state.Deliveries["queued/in-app"].Status != "available" {
		t.Fatalf("evaluation starvation: %+v", state.Deliveries)
	}
}

func TestColdRebuildPendingKeepsExpiryAnnouncementsAndCursorProgress(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{81}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	expiry := now.Add(time.Hour)
	for i := 0; i < 101; i++ {
		id := fmt.Sprintf("u%03d", i)
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: true, QuotaBytes: 1}); err != nil {
			t.Fatal(err)
		}
		if err = s.Put("entitlements", id, service.Entitlement{UserID: id, StartsAt: now.Add(-time.Hour), ExpiresAt: &expiry, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"a", "b"} {
		if err = s.Put("ledger", id, store.MeterRecord{MeterBatch: store.MeterBatch{UserID: "u000", RawBytes: 100, ObservedAt: now}, RateMicros: 1000000}); err != nil {
			t.Fatal(err)
		}
	}
	n := notifications.New(s, nil)
	if err = n.SaveAnnouncement(notifications.Announcement{ID: "notice", Title: "Notice", Body: "Independent of usage", Audience: "all", StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Enabled: true}); err != nil {
		t.Fatal(err)
	}
	budget := store.NotificationColdBudget{Rows: 1, Bytes: 1024}
	after := ""
	wrapped := false
	for tick := 0; tick < 20; tick++ {
		logicalNow := now.Add(time.Duration(tick) * 2 * time.Minute)
		next, runErr := runNotificationBatchWithBudget(context.Background(), s, after, logicalNow, 5*time.Second, budget)
		if runErr != nil && !errors.Is(runErr, store.ErrNotificationRebuildPending) && !errors.Is(runErr, context.DeadlineExceeded) {
			t.Fatalf("unexpected batch failure: %v", runErr)
		}
		if next != "" && next < after {
			t.Fatalf("cold refusal blocked cursor: after=%q next=%q", after, next)
		}
		if next == "" {
			wrapped = true
		}
		after = next
		complete := wrapped
		for _, id := range []string{"u000", "u100"} {
			items, e := n.Inbox(notifications.Recipient{ID: id, Role: "user", Enabled: true}, logicalNow)
			if e != nil {
				t.Fatal(e)
			}
			expiryFound, announcementFound := false, false
			for _, item := range items {
				switch item.Kind {
				case "quota":
					// Later visits may complete reconstruction; the dedicated
					// small-fixture test asserts no quota before completion.
				case "expiry":
					expiryFound = true
				case "announcement":
					announcementFound = true
				}
			}
			if !expiryFound || !announcementFound {
				complete = false
			}
		}
		if complete {
			return
		}
	}
	t.Fatal("cold refusal starved usage-independent notices or cursor wrap across 20 ticks")

}
func TestPartialEnqueueResumesAfterCommittedUserNotInputPage(t *testing.T) {
	all := []notifications.Recipient{{ID: "operator", Role: "admin", Enabled: true}}
	for i := 0; i < 100; i++ {
		all = append(all, notifications.Recipient{ID: fmt.Sprintf("u%03d", i), Role: "user", Enabled: true})
	}
	seen := map[string]bool{}
	after := ""
	for tick := 0; tick < 20; tick++ {
		recipients := []notifications.Recipient{}
		for _, r := range all {
			if (r.Role == "admin" && after == "") || (r.Role == "user" && r.ID > after) {
				recipients = append(recipients, r)
			}
		}
		calls := 0
		next, err := evaluateNotificationRecipients(context.Background(), recipients, nil, after, "", time.Now(), func(_ context.Context, chunk []notifications.Recipient, _ []notifications.UserSnapshot, _ time.Time) error {
			calls++
			if calls == 2 {
				return context.DeadlineExceeded
			}
			for _, r := range chunk {
				seen[r.ID] = true
			}
			return nil
		})
		if err == nil {
			if next != "" {
				t.Fatal("did not wrap")
			}
			break
		}
		if !errors.Is(err, context.DeadlineExceeded) || next <= after {
			t.Fatalf("partial progress lost: after=%q next=%q err=%v", after, next, err)
		}
		after = next
	}
	if len(seen) != 101 || !seen["u099"] {
		t.Fatalf("partial enqueue starved tail: recipients=%d tail=%v", len(seen), seen["u099"])
	}
}

func TestNotificationRebuildPendingDoesNotHideDeliveryFailure(t *testing.T) {
	delivery := errors.New("synthetic delivery failure")
	got := notificationBatchError(store.ErrNotificationRebuildPending, delivery)
	if !errors.Is(got, delivery) || errors.Is(got, store.ErrNotificationRebuildPending) {
		t.Fatalf("pending hid actual failure: %v", got)
	}
	if got = notificationBatchError(store.ErrNotificationRebuildPending, nil); !errors.Is(got, store.ErrNotificationRebuildPending) {
		t.Fatalf("pending status lost: %v", got)
	}
}

func TestNotificationPendingRebuildEventuallyEvaluatesQuotaWithoutBlockingOutbox(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{84}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	expiry := now.Add(time.Hour)
	if err = s.PutUser(domain.User{ID: "u", Name: "User", Enabled: true, QuotaBytes: 2}); err != nil {
		t.Fatal(err)
	}
	if err = s.PutEntitlement(service.Entitlement{UserID: "u", StartsAt: now.Add(-time.Hour), ExpiresAt: &expiry, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if err = s.Put("ledger", id, store.MeterRecord{MeterBatch: store.MeterBatch{UserID: "u", RawBytes: 1, ObservedAt: now}, RateMicros: 500000}); err != nil {
			t.Fatal(err)
		}
	}
	n := notifications.New(s, nil)
	if err = n.SaveAnnouncement(notifications.Announcement{ID: "notice", Title: "Notice", Body: "Independent", Audience: "all", StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for step := 0; step < 3; step++ {
		logicalNow := now.Add(time.Duration(step) * time.Minute)
		_, err = runNotificationBatchWithBudget(context.Background(), s, "", logicalNow, 5*time.Second, store.NotificationColdBudget{Rows: 1, Bytes: 4096})
		if step < 2 {
			if !errors.Is(err, store.ErrNotificationRebuildPending) {
				t.Fatal(err)
			}
		} else if err != nil {
			t.Fatal(err)
		}
		items, e := n.Inbox(notifications.Recipient{ID: "u", Role: "user", Enabled: true}, logicalNow)
		if e != nil {
			t.Fatal(e)
		}
		announcement, quota := false, false
		for _, item := range items {
			announcement = announcement || item.Kind == "announcement"
			quota = quota || item.Kind == "quota"
		}
		if !announcement {
			t.Fatal("pending reconstruction blocked independent outbox")
		}
		if step < 2 && quota {
			t.Fatal("partial totals authorized quota notice")
		}
		if step == 2 && !quota {
			t.Fatal("completed reconstruction failed to evaluate exact quota")
		}
	}
}

func TestNotificationContinuationDelayYieldsAndBacksOff(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want time.Duration
	}{
		{"complete", nil, time.Minute},
		{"committed pending", store.ErrNotificationRebuildPending, time.Second},
		{"deadline", context.DeadlineExceeded, time.Minute},
		{"oversized", store.ErrNotificationColdBudget, time.Minute},
		{"corrupt", errors.New("corrupt canonical record"), time.Minute},
		{"pending with delivery failure", notificationBatchError(store.ErrNotificationRebuildPending, errors.New("delivery failed")), time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := notificationContinuationDelay(time.Minute, tc.err); got != tc.want {
				t.Fatalf("delay=%s want=%s", got, tc.want)
			}
		})
	}
	if got := notificationContinuationDelay(time.Second, store.ErrNotificationRebuildPending); got != time.Second {
		t.Fatal(got)
	}
}
