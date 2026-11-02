package notifications_test

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/notifications"
)

type matrixSink struct {
	calls []string
	fail  bool
}

func (s *matrixSink) Send(_ context.Context, channel string, event notifications.Event, _ notifications.Settings, _ notifications.Secrets) error {
	s.calls = append(s.calls, channel+":"+event.EventID)
	if s.fail {
		return fmt.Errorf("synthetic private destination failure")
	}
	return nil
}
func matrixSettings(t *testing.T, s *notifications.Service, automatic bool) {
	t.Helper()
	v, err := s.Settings()
	if err != nil {
		t.Fatal(err)
	}
	v.QuotaPercent = []int{80}
	v.ExpiryHours = []int{24}
	v.ProviderRemainingPercent = []int{10}
	v.Email = notifications.EmailSettings{Enabled: true, Automatic: automatic, Host: "smtp.example.com", Port: 465, TLSMode: "tls", From: "sender@example.com", To: []string{"operator@example.com"}}
	v.Webhook = notifications.WebhookSettings{Enabled: true, Automatic: automatic, URL: "https://hooks.example.com/events"}
	secret := "synthetic-matrix-signing-value-not-a-real-secret"
	if _, err = s.SaveSettings(notifications.SettingsInput{Settings: v.Settings, WebhookSecret: &secret}); err != nil {
		t.Fatal(err)
	}
}

// This finite matrix tests routing through the public service and encrypted store.
// External sends terminate in a recording sink, not a real email or HTTP receiver.
func TestNotificationEventAudienceChannelAcceptanceMatrix(t *testing.T) {
	cases := []struct {
		name, kind, audience string
		visible              []string
		provider             bool
	}{
		{"announcement-all", "announcement", "all", []string{"alice", "bob", "operator"}, false},
		{"announcement-selected", "announcement", "users", []string{"alice"}, false},
		{"announcement-admins", "announcement", "admins", []string{"operator"}, false},
		{"account-quota", "quota", "", []string{"alice"}, false},
		{"account-expiry", "expiry", "", []string{"alice"}, false},
		{"provider-quota", "provider-quota", "", []string{"operator"}, true},
		{"provider-expiry", "provider-expiry", "", []string{"operator"}, true},
	}
	for _, tc := range cases {
		for _, automatic := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/automatic=%t", tc.name, automatic), func(t *testing.T) {
				sink := &matrixSink{}
				s := notifications.New(repo(t), sink)
				matrixSettings(t, s, automatic)
				now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
				expiry := now.Add(time.Hour)
				recipients := []notifications.Recipient{{ID: "alice", Role: "user", Enabled: true}, {ID: "bob", Role: "user", Enabled: true}, {ID: "operator", Role: "admin", Enabled: true}, {ID: "disabled", Role: "admin", Enabled: false}}
				generate := func() error {
					if tc.kind == "announcement" {
						ids := []string{}
						if tc.audience == "users" {
							ids = []string{"alice"}
						}
						if err := s.SaveAnnouncement(notifications.Announcement{ID: "notice", Title: "Notice", Body: "Synthetic notice", Audience: tc.audience, UserIDs: ids, StartsAt: now.Add(-time.Minute), ExpiresAt: expiry, Enabled: true}); err != nil {
							return err
						}
						return s.Evaluate(recipients, nil, now)
					}
					if tc.provider {
						p := notifications.ProviderSnapshot{ID: "provider", CycleID: "cycle", ObservedAt: now, TotalBytes: 100, RemainingBytes: 50, Source: "provider_statement"}
						if tc.kind == "provider-quota" {
							p.RemainingBytes = 5
						} else {
							p.ExpiresAt = &expiry
						}
						return s.EvaluateProvider(p, now)
					}
					u := notifications.UserSnapshot{UserID: "alice", Enabled: true, CycleID: "cycle", QuotaBytes: 100}
					if tc.kind == "quota" {
						u.UsedBytes = 80
					} else {
						u.ExpiresAt = &expiry
					}
					return s.Evaluate(recipients, []notifications.UserSnapshot{u}, now)
				}
				if err := generate(); err != nil {
					t.Fatal(err)
				}
				if err := generate(); err != nil {
					t.Fatal(err)
				}
				if err := s.Dispatch(context.Background(), recipients, now); err != nil {
					t.Fatal(err)
				}
				visible := []string{}
				for _, r := range recipients {
					inbox, err := s.Inbox(r, now)
					if err != nil {
						t.Fatal(err)
					}
					if len(inbox) > 0 {
						if len(inbox) != 1 || inbox[0].Kind != tc.kind {
							t.Fatalf("unexpected inbox %s: %+v", r.ID, inbox)
						}
						visible = append(visible, r.ID)
					}
				}
				sort.Strings(visible)
				if !reflect.DeepEqual(visible, tc.visible) {
					t.Fatalf("audience got %v want %v", visible, tc.visible)
				}
				out, err := s.Outbox()
				if err != nil {
					t.Fatal(err)
				}
				counts := map[string]int{}
				for _, d := range out {
					if d.Kind != tc.kind {
						t.Fatalf("unexpected event %+v", d)
					}
					counts[d.Channel]++
					want := "available"
					if d.Channel != "in-app" {
						want = "accepted"
					}
					if d.Status != want {
						t.Fatalf("status %+v", d)
					}
				}
				want := map[string]int{"in-app": len(tc.visible)}
				if tc.provider {
					want["in-app"] = 1
					if automatic {
						want["email"] = 1
						want["webhook"] = 1
					}
				}
				if !reflect.DeepEqual(counts, want) {
					t.Fatalf("channel routing got %v want %v", counts, want)
				}
				sends := 0
				if tc.provider && automatic {
					sends = 2
				}
				if len(sink.calls) != sends {
					t.Fatalf("external sends %v", sink.calls)
				}
				if err := s.Dispatch(context.Background(), recipients, now.Add(time.Minute)); err != nil {
					t.Fatal(err)
				}
				if len(sink.calls) != sends {
					t.Fatal("accepted event resent")
				}
				if tc.kind == "announcement" || strings.HasSuffix(tc.kind, "expiry") {
					for _, r := range recipients {
						items, err := s.Inbox(r, expiry)
						if err != nil || len(items) != 0 {
							t.Fatalf("expiry leaked %+v %v", items, err)
						}
					}
				}
			})
		}
	}
}

func TestNotificationExplicitChannelFailureRetryMatrix(t *testing.T) {
	for _, channel := range []string{"in-app", "email", "webhook"} {
		t.Run(channel, func(t *testing.T) {
			sink := &matrixSink{fail: true}
			s := notifications.New(repo(t), sink)
			matrixSettings(t, s, false)
			admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
			user := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
			disabled := admin
			disabled.Enabled = false
			now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
			for _, r := range []notifications.Recipient{user, disabled} {
				if _, err := s.Test(channel, r, now); err == nil {
					t.Fatal("unauthorized explicit test")
				}
			}
			id, err := s.Test(channel, admin, now)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Dispatch(context.Background(), []notifications.Recipient{admin, user}, now); err != nil {
				t.Fatal(err)
			}
			out, err := s.Outbox()
			if err != nil || len(out) != 1 {
				t.Fatalf("outbox %+v %v", out, err)
			}
			d := out[0]
			if d.EventID != id || d.Channel != channel || d.Attempts != 1 {
				t.Fatalf("identity %+v", d)
			}
			if channel == "in-app" {
				if d.Status != "available" || len(sink.calls) != 0 {
					t.Fatalf("in-app reached transport: %+v", d)
				}
				return
			}
			if d.Status != "retrying" || d.LastError == "" || strings.Contains(d.LastError, "synthetic private") {
				t.Fatalf("failure visibility/redaction %+v", d)
			}
			if err = notifications.DispatchWithClockForTest(s, context.Background(), []notifications.Recipient{admin}, func() time.Time { return d.NextAttemptAt.Add(-time.Nanosecond) }); err != nil {
				t.Fatal(err)
			}
			if len(sink.calls) != 1 {
				t.Fatal("retry before due")
			}
			sink.fail = false
			if err = s.Dispatch(context.Background(), []notifications.Recipient{admin}, d.NextAttemptAt); err != nil {
				t.Fatal(err)
			}
			out, err = s.Outbox()
			if err != nil || len(out) != 1 || out[0].Status != "accepted" || out[0].Attempts != 2 || out[0].LastError != "" || len(sink.calls) != 2 || sink.calls[0] != sink.calls[1] {
				t.Fatalf("retry identity/acceptance %+v %v calls=%v", out, err, sink.calls)
			}
		})
	}
}

func TestNotificationExternalTerminalFailureMatrix(t *testing.T) {
	for _, channel := range []string{"email", "webhook"} {
		t.Run(channel, func(t *testing.T) {
			sink := &matrixSink{fail: true}
			s := notifications.New(repo(t), sink)
			matrixSettings(t, s, false)
			admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
			now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
			id, err := s.Test(channel, admin, now)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < notifications.MaxAttempts; i++ {
				if err = notifications.DispatchWithClockForTest(s, context.Background(), []notifications.Recipient{admin}, func() time.Time { return now }); err != nil {
					t.Fatal(err)
				}
				out, e := s.Outbox()
				if e != nil || len(out) != 1 {
					t.Fatalf("outbox %+v %v", out, e)
				}
				d := out[0]
				if d.EventID != id || d.Attempts != i+1 || len(sink.calls) != i+1 || d.LastError == "" || strings.Contains(d.LastError, "synthetic private") {
					t.Fatalf("failure %+v calls=%v", d, sink.calls)
				}
				want := "retrying"
				if i == notifications.MaxAttempts-1 {
					want = "failed"
				}
				if d.Status != want {
					t.Fatalf("status %+v", d)
				}
				now = d.NextAttemptAt
			}
			if err = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(24*time.Hour)); err != nil {
				t.Fatal(err)
			}
			if len(sink.calls) != notifications.MaxAttempts {
				t.Fatal("terminal event resent")
			}
		})
	}
}

func TestNotificationExpiredProviderDeliveryChannelMatrix(t *testing.T) {
	sink := &matrixSink{}
	s := notifications.New(repo(t), sink)
	matrixSettings(t, s, true)
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	expiry := now.Add(time.Hour)
	p := notifications.ProviderSnapshot{ID: "provider", CycleID: "cycle", ObservedAt: now, TotalBytes: 100, RemainingBytes: 50, Source: "provider_statement", ExpiresAt: &expiry}
	if err := s.EvaluateProvider(p, now); err != nil {
		t.Fatal(err)
	}
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	if err := s.Dispatch(context.Background(), []notifications.Recipient{admin}, expiry); err != nil {
		t.Fatal(err)
	}
	out, err := s.Outbox()
	if err != nil || len(out) != 3 {
		t.Fatalf("outbox %+v %v", out, err)
	}
	seen := map[string]bool{}
	for _, d := range out {
		seen[d.Channel] = true
		if d.Status != "cancelled" || d.Attempts != 0 || d.LastError == "" {
			t.Fatalf("expired status %+v", d)
		}
	}
	if !reflect.DeepEqual(seen, map[string]bool{"in-app": true, "email": true, "webhook": true}) || len(sink.calls) != 0 {
		t.Fatalf("expired routing %v, calls %v", seen, sink.calls)
	}
	items, err := s.Inbox(admin, expiry)
	if err != nil || len(items) != 0 {
		t.Fatalf("expired inbox %+v %v", items, err)
	}
}
