package store_test

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestNotificationHistoryDoesNotExpandHotOperationSnapshots(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{19}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err = s.UpdateNotifications(func(st *notifications.State) error {
		for i := 0; i < 1200; i++ {
			a := fmt.Sprintf("expired-%04d", i)
			st.Announcements[a] = notifications.Announcement{ID: a, Title: "Old announcement", Body: "Retained definition", StartsAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)}
			id := fmt.Sprintf("history-%04d", i)
			owner := "alice"
			if i%2 == 0 {
				owner = "bob"
			}
			st.Events[id] = notifications.Event{EventID: id, RecipientID: owner, Kind: "quota", Title: "Retained", Body: "Historical payload", CreatedAt: now.Add(time.Duration(i) * time.Second)}
			st.Deliveries[id+"/in-app"] = notifications.Delivery{EventID: id, Channel: "in-app", Status: "available", CreatedAt: now.Add(time.Duration(i) * time.Second)}
		}
		st.Events["due"] = notifications.Event{EventID: "due", RecipientID: "alice", Title: "Due", CreatedAt: now}
		st.Deliveries["due/in-app"] = notifications.Delivery{EventID: "due", Channel: "in-app", Status: "queued", CreatedAt: now, NextAttemptAt: now}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	settings, err := s.ReadNotificationsScope(notifications.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Events)+len(settings.Deliveries)+len(settings.Reads) != 0 {
		t.Fatal("settings loads historical notifications")
	}
	pending, err := s.ReadNotificationsScope(notifications.Scope{PendingAt: &now})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending.Events) != 1 || len(pending.Deliveries) != 1 || len(pending.Announcements) != 0 {
		t.Fatalf("claim loads terminal history: %d events %d deliveries", len(pending.Events), len(pending.Deliveries))
	}
	recipient := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	page, err := s.ReadNotificationsScope(notifications.Scope{Inbox: &recipient, InboxAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 200 || len(page.Announcements) != 0 {
		t.Fatalf("bounded inbox page = %d", len(page.Events))
	}
	history, err := s.ReadNotificationsScope(notifications.Scope{History: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Deliveries) != 500 {
		t.Fatalf("bounded outbox page = %d", len(history.Deliveries))
	}
	n := notifications.New(s, nil)
	if err = n.DeliverInApp(context.Background(), []notifications.Recipient{recipient}, now); err != nil {
		t.Fatal(err)
	}
	all, err := s.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Events) != 1201 || all.Deliveries["due/in-app"].Status != "available" {
		t.Fatalf("dispatch changed retained evidence: %d", len(all.Events))
	}
	if err = n.MarkRead(recipient, "history-1199", now); err != nil {
		t.Fatal(err)
	}
	items, err := n.Inbox(recipient, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 200 || items[0].EventID != "history-1199" || items[0].ReadAt == nil {
		t.Fatalf("ordered bounded inbox lost receipt: %+v", items[0])
	}
}

func TestDispatchContinuesPastBoundedCancelledPage(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{29}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err = s.UpdateNotifications(func(st *notifications.State) error {
		for i := 0; i < 129; i++ {
			id := fmt.Sprintf("event-%03d", i)
			owner := "removed"
			if i == 128 {
				owner = "alice"
			}
			st.Events[id] = notifications.Event{EventID: id, RecipientID: owner, Title: "Notice", CreatedAt: now}
			st.Deliveries[id+"/in-app"] = notifications.Delivery{EventID: id, Channel: "in-app", Status: "queued", CreatedAt: now, NextAttemptAt: now}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	n := notifications.New(s, nil)
	alice := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	if err = n.DeliverInApp(context.Background(), []notifications.Recipient{alice}, now); err != nil {
		t.Fatal(err)
	}
	inbox, err := n.Inbox(alice, now)
	if err != nil || len(inbox) != 1 || inbox[0].EventID != "event-128" {
		t.Fatalf("cancelled page hid due work: %+v %v", inbox, err)
	}
}

func TestInboxSkipsExpiredHistoryWithoutRetainingDefinitions(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{39}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if err = s.UpdateNotifications(func(st *notifications.State) error {
		for i := 0; i < 1200; i++ {
			id := fmt.Sprintf("expired-%04d", i)
			st.Announcements[id] = notifications.Announcement{ID: id, Title: "Expired", StartsAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour), Enabled: true, Audience: "all"}
			st.Events[id] = notifications.Event{EventID: id, RecipientID: "alice", AnnouncementID: id, CreatedAt: now.Add(time.Duration(i) * time.Second)}
			st.Deliveries[id+"/in-app"] = notifications.Delivery{EventID: id, Channel: "in-app", Status: "available", CreatedAt: now}
		}
		st.Events["older-valid"] = notifications.Event{EventID: "older-valid", RecipientID: "alice", Title: "Retained visible", CreatedAt: now.Add(-time.Hour)}
		st.Deliveries["older-valid/in-app"] = notifications.Delivery{EventID: "older-valid", Channel: "in-app", Status: "available", CreatedAt: now.Add(-time.Hour)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	alice := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	page, err := s.ReadNotificationsScope(notifications.Scope{Inbox: &alice, InboxAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || len(page.Announcements) != 0 {
		t.Fatalf("filtered history expanded inbox snapshot: %d events %d definitions", len(page.Events), len(page.Announcements))
	}
	if _, ok := page.Events["older-valid"]; !ok {
		t.Fatal("expired prefix hid older eligible item")
	}
}
