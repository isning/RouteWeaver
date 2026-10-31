package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestWorkerPageDoesNotCancelRecipientsOutsideItsEvaluationPage(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{73}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 101; i++ {
		id := fmt.Sprintf("u%03d", i)
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.UpdateNotifications(func(st *notifications.State) error {
		st.Events["outside"] = notifications.Event{EventID: "outside", RecipientID: "u100", Title: "Previously queued", CreatedAt: now}
		st.Deliveries["outside/in-app"] = notifications.Delivery{EventID: "outside", Channel: "in-app", Status: "queued", NextAttemptAt: now, CreatedAt: now}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	next, err := httpapi.RunNotificationBatch(context.Background(), s, "", now)
	if err != nil || next != "u099" {
		t.Fatalf("bounded worker page: next=%q %v", next, err)
	}
	state, err := s.ReadNotificationsScope(notifications.Scope{EventIDs: []string{"outside"}})
	if err != nil {
		t.Fatal(err)
	}
	if state.Deliveries["outside/in-app"].Status != "available" {
		t.Fatalf("worker cancelled current recipient outside its page: %+v", state.Deliveries)
	}
}

func TestNotificationWorkerCancellationDoesNotStartEvaluation(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{74}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = httpapi.RunNotificationBatch(ctx, s, "", time.Now()); err == nil {
		t.Fatal("cancelled worker reported completed evaluation")
	}
	state, err := s.ReadNotifications()
	if err != nil || len(state.Events) != 0 {
		t.Fatalf("cancelled worker mutated notifications: %+v %v", state, err)
	}
}

func TestNotificationWorkerRepresentativePageSweep(t *testing.T) {
	for _, count := range []int{5, 500} {
		t.Run(fmt.Sprintf("users-%d", count), func(t *testing.T) {
			s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{77}, 32))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			writes := make([]store.RecordWrite, 0, count)
			for i := 0; i < count; i++ {
				id := fmt.Sprintf("u%04d", i)
				writes = append(writes, store.RecordWrite{Kind: "users", ID: id, Value: domain.User{ID: id, Name: id, Enabled: true}})
			}
			if err = s.UpdateRecords("unused", "unused", func(json.RawMessage) ([]store.RecordWrite, error) { return writes, nil }); err != nil {
				t.Fatal(err)
			}
			n := notifications.New(s, nil)
			now := time.Now().UTC()
			if err = n.SaveAnnouncement(notifications.Announcement{ID: "worker-fixture", Title: "Worker fixture", Body: "Synthetic notice", Audience: "all", StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(24 * time.Hour), Enabled: true}); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			after := ""
			batches := 0
			lastEvents := 0
			lastAvailable := 0
			stalledDelivery := 0
			stagnant := 0
			for {
				logicalNow := now.Add(time.Duration(batches) * 2 * time.Minute)
				next, e := httpapi.RunNotificationBatch(context.Background(), s, after, logicalNow)
				if e != nil && !errors.Is(e, context.DeadlineExceeded) {
					t.Fatal(e)
				}
				records, readErr := s.List("notification-events")
				if readErr != nil {
					t.Fatal(readErr)
				}
				if len(records) < lastEvents {
					t.Fatal("committed notification progress regressed")
				}
				if len(records) == lastEvents && next == after {
					stagnant++
				} else {
					stagnant = 0
				}
				if stagnant >= 3 {
					t.Fatal("worker made no cursor or committed-event progress in three ticks")
				}
				t.Logf("batch=%d cursor=%q next=%q committed-events=%d error=%v", batches, after, next, len(records), e)
				deliveries, readErr := s.List("notification-deliveries")
				if readErr != nil {
					t.Fatal(readErr)
				}
				available := 0
				for _, raw := range deliveries {
					var d notifications.Delivery
					if err = json.Unmarshal(raw, &d); err != nil {
						t.Fatal(err)
					}
					if d.Status == "available" {
						available++
					}
				}
				if available < lastAvailable {
					t.Fatal("durable delivery progress regressed")
				}
				if available == lastAvailable && len(records) > available {
					stalledDelivery++
				} else {
					stalledDelivery = 0
				}
				t.Logf("batch=%d available=%d", batches, available)
				if stalledDelivery >= 3 {
					t.Fatal("durable outbox made no accepted in-app progress in three ticks")
				}
				lastAvailable = available
				lastEvents = len(records)
				batches++
				if next == "" {
					complete := true
					for _, index := range []int{0, count / 2, count - 1} {
						inbox, readErr := n.Inbox(notifications.Recipient{ID: fmt.Sprintf("u%04d", index), Role: "user", Enabled: true}, logicalNow)
						if readErr != nil {
							t.Fatal(readErr)
						}
						if len(inbox) != 1 {
							complete = false
						}
					}
					if complete {
						break
					}
				}
				if batches > 200 {
					t.Fatal("sampled visibility did not complete within 200 bounded batches")
				}
				after = next
			}
			for _, index := range []int{0, count / 2, count - 1} {
				id := fmt.Sprintf("u%04d", index)
				inbox, e := n.Inbox(notifications.Recipient{ID: id, Role: "user", Enabled: true}, time.Now().UTC())
				if e != nil || len(inbox) != 1 {
					t.Fatalf("representative recipient %s not visible after sweep: %+v %v", id, inbox, e)
				}
			}
			t.Logf("synthetic users=%d, one announcement, pages=%d, back-to-back evaluation+dispatch+sampled-visibility elapsed=%s; excludes production tick pacing", count, batches, time.Since(started))
		})
	}
}
