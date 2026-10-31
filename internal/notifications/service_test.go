package notifications_test

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func repo(t *testing.T) *store.Store {
	t.Helper()
	s, e := store.Open(filepath.Join(t.TempDir(), "test.db"), bytes.Repeat([]byte{41}, 32))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestAnnouncementAudienceExpiryAndPrivateReadReceipts(t *testing.T) {
	s := notifications.New(repo(t), nil)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	a := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	b := notifications.Recipient{ID: "bob", Role: "user", Enabled: true}
	announcement := notifications.Announcement{ID: "maintenance", Title: "Maintenance", Body: "A private update", Audience: "users", UserIDs: []string{"alice"}, StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Enabled: true}
	if e := s.SaveAnnouncement(announcement); e != nil {
		t.Fatal(e)
	}
	if e := s.Evaluate([]notifications.Recipient{a, b}, nil, now); e != nil {
		t.Fatal(e)
	}
	if e := s.Dispatch(context.Background(), []notifications.Recipient{a, b}, now); e != nil {
		t.Fatal(e)
	}
	inbox, e := s.Inbox(a, now)
	if e != nil || len(inbox) != 1 || inbox[0].Title != "Maintenance" {
		t.Fatalf("eligible inbox: %+v %v", inbox, e)
	}
	other, e := s.Inbox(b, now)
	if e != nil || len(other) != 0 {
		t.Fatalf("private audience leaked: %+v %v", other, e)
	}
	if e := s.MarkRead(b, inbox[0].EventID, now); e != notifications.ErrNotFound {
		t.Fatalf("read IDOR: %v", e)
	}
	if e := s.MarkRead(a, inbox[0].EventID, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ = s.Inbox(a, now)
	if inbox[0].ReadAt == nil {
		t.Fatal("read receipt not persisted")
	}
	announcement.UserIDs = []string{"bob"}
	if e = s.SaveAnnouncement(announcement); e != nil {
		t.Fatal(e)
	}
	inbox, _ = s.Inbox(a, now)
	if len(inbox) != 0 {
		t.Fatal("revoked audience remains visible")
	}
	if e = s.Evaluate([]notifications.Recipient{a, b}, nil, now); e != nil {
		t.Fatal(e)
	}
	if e = s.Dispatch(context.Background(), []notifications.Recipient{a, b}, now); e != nil {
		t.Fatal(e)
	}
	other, _ = s.Inbox(b, now)
	if len(other) != 1 || other[0].ReadAt != nil {
		t.Fatal("read receipt crossed users")
	}
	expired, _ := s.Inbox(b, now.Add(2*time.Hour))
	if len(expired) != 0 {
		t.Fatal("expired announcement visible")
	}
}

func TestThresholdDeduplicationAndNewCycles(t *testing.T) {
	s := notifications.New(repo(t), nil)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	recipient := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	expiry := now.Add(23 * time.Hour)
	u := notifications.UserSnapshot{UserID: "alice", Enabled: true, QuotaBytes: 100, UsedBytes: 80, CycleID: "cycle-1", ExpiresAt: &expiry}
	for i := 0; i < 3; i++ {
		if e := s.Evaluate([]notifications.Recipient{recipient}, []notifications.UserSnapshot{u}, now); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.DeliverInApp(context.Background(), []notifications.Recipient{recipient}, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ := s.Inbox(recipient, now)
	if len(inbox) != 3 {
		t.Fatalf("one quota and two configured expiry thresholds expected, got %+v", inbox)
	}
	u.CycleID = "cycle-2"
	u.UsedBytes = 100
	if e := s.Evaluate([]notifications.Recipient{recipient}, []notifications.UserSnapshot{u}, now); e != nil {
		t.Fatal(e)
	}
	if e := s.DeliverInApp(context.Background(), []notifications.Recipient{recipient}, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ = s.Inbox(recipient, now)
	if len(inbox) != 5 {
		t.Fatalf("new cycle must admit two quota thresholds: %+v", inbox)
	}
}

type localDelivery struct {
	events []notifications.Event
	fail   bool
	crash  bool
}

func (d *localDelivery) Send(_ context.Context, _ string, e notifications.Event, _ notifications.Settings, _ notifications.Secrets) error {
	d.events = append(d.events, e)
	if d.crash {
		panic("synthetic process loss after receiver accepted")
	}
	if d.fail {
		return fmt.Errorf("private-password-secret https://private.example/token")
	}
	return nil
}
func configuredWebhook(t *testing.T, s *notifications.Service) {
	t.Helper()
	v, e := s.Settings()
	if e != nil {
		t.Fatal(e)
	}
	v.Webhook = notifications.WebhookSettings{Enabled: true, URL: "https://notifications.example.com/events"}
	secret := "synthetic-signing-secret-that-is-not-real"
	if _, e = s.SaveSettings(notifications.SettingsInput{Settings: v.Settings, WebhookSecret: &secret}); e != nil {
		t.Fatal(e)
	}
}
func TestDurableOutboxRestartStableIdentityAndBoundedRetries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "durable.db")
	encryptionKey := bytes.Repeat([]byte{17}, 32)
	db, e := store.Open(path, encryptionKey)
	if e != nil {
		t.Fatal(e)
	}
	local := &localDelivery{fail: true}
	s := notifications.New(db, local)
	configuredWebhook(t, s)
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	id, e := s.Test("webhook", admin, now)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now); e != nil {
		t.Fatal(e)
	}
	out, e := s.Outbox()
	if e != nil || len(out) != 1 || out[0].Status != "retrying" || out[0].Attempts != 1 || strings.Contains(out[0].LastError, "private-password") {
		t.Fatalf("failed delivery state: %+v %v", out, e)
	}
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	db, e = store.Open(path, encryptionKey)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	s = notifications.New(db, local)
	local.fail = false
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, out[0].NextAttemptAt); e != nil {
		t.Fatal(e)
	}
	out, _ = s.Outbox()
	if len(out) != 1 || out[0].Status != "accepted" || out[0].Attempts != 2 || out[0].EventID != id || len(local.events) != 2 || local.events[0].EventID != local.events[1].EventID {
		t.Fatalf("restart retry lost identity: %+v events=%+v", out, local.events)
	}
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(2*time.Minute)); e != nil {
		t.Fatal(e)
	}
	if len(local.events) != 2 {
		t.Fatal("accepted event sent again")
	}
	local.fail = true
	failureID, e := s.Test("webhook", admin, now.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 10; i++ {
		if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(time.Hour+time.Duration(i)*time.Hour)); e != nil {
			t.Fatal(e)
		}
	}
	out, _ = s.Outbox()
	found := false
	for _, d := range out {
		if d.EventID == failureID {
			found = true
			if d.Status != "failed" || d.Attempts != notifications.MaxAttempts {
				t.Fatalf("unbounded retries: %+v", d)
			}
		}
	}
	if !found {
		t.Fatal("missing terminal failure")
	}
}
func TestCrashAfterAcceptanceReusesEventIDAndRechecksSettings(t *testing.T) {
	db := repo(t)
	local := &localDelivery{crash: true}
	s := notifications.New(db, local)
	configuredWebhook(t, s)
	admin := notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	id, e := s.Test("webhook", admin, now)
	if e != nil {
		t.Fatal(e)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected synthetic crash")
			}
		}()
		_ = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now)
	}()
	local.crash = false
	s = notifications.New(db, local)
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(30*time.Second)); e != nil {
		t.Fatal(e)
	}
	if len(local.events) != 1 {
		t.Fatal("active lease duplicated delivery")
	}
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(61*time.Second)); e != nil {
		t.Fatal(e)
	}
	if len(local.events) != 2 || local.events[1].EventID != id {
		t.Fatal("at-least-once retry changed identity")
	}
	pending, e := s.Test("webhook", admin, now.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	settings, _ := s.Settings()
	settings.Webhook.URL = "https://changed.example.com/events"
	if _, e = s.SaveSettings(notifications.SettingsInput{Settings: settings.Settings}); e != nil {
		t.Fatal(e)
	}
	if e = s.Dispatch(context.Background(), []notifications.Recipient{admin}, now.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	out, _ := s.Outbox()
	for _, d := range out {
		if d.EventID == pending && d.Status != "cancelled" {
			t.Fatalf("queued payload retargeted after settings changed: %+v", d)
		}
	}
	if len(local.events) != 2 {
		t.Fatal("changed destination received old explicit-send authorization")
	}
}
func TestProviderObservationFreshnessAndExplicitAutomaticPermission(t *testing.T) {
	s := notifications.New(repo(t), &localDelivery{})
	configuredWebhook(t, s)
	now := time.Now().UTC()
	p := notifications.ProviderSnapshot{ID: "provider-resource", CycleID: "october", TotalBytes: 1000, RemainingBytes: 90, ObservedAt: now.Add(-time.Hour)}
	if e := s.EvaluateProvider(p, now); e == nil {
		t.Fatal("stale observation treated as current")
	}
	p.ObservedAt = now
	if e := s.EvaluateProvider(p, now); e != nil {
		t.Fatal(e)
	}
	out, _ := s.Outbox()
	if len(out) != 1 || out[0].Channel != "in-app" {
		t.Fatalf("enabled without automatic permission sent externally: %+v", out)
	}
	settings, _ := s.Settings()
	settings.Webhook.Automatic = true
	if _, e := s.SaveSettings(notifications.SettingsInput{Settings: settings.Settings}); e != nil {
		t.Fatal(e)
	}
	p.CycleID = "november"
	if e := s.EvaluateProvider(p, now); e != nil {
		t.Fatal(e)
	}
	out, _ = s.Outbox()
	if len(out) != 3 {
		t.Fatalf("new cycle should enqueue one in-app and one approved webhook: %+v", out)
	}
}

func TestAnnouncementEditsRecheckCurrentValidityAndRetainReadReceipt(t *testing.T) {
	s := notifications.New(repo(t), nil)
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	alice := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	a := notifications.Announcement{ID: "notice", Title: "Initial", Body: "Notice", Audience: "all", StartsAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Minute), Enabled: true}
	if e := s.SaveAnnouncement(a); e != nil {
		t.Fatal(e)
	}
	if e := s.Evaluate([]notifications.Recipient{alice}, nil, now); e != nil {
		t.Fatal(e)
	}
	if e := s.DeliverInApp(context.Background(), []notifications.Recipient{alice}, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ := s.Inbox(alice, now)
	if len(inbox) != 1 {
		t.Fatal("missing announcement")
	}
	if e := s.MarkRead(alice, inbox[0].EventID, now); e != nil {
		t.Fatal(e)
	}
	a.Title = "Updated"
	a.ExpiresAt = now.Add(time.Hour)
	if e := s.SaveAnnouncement(a); e != nil {
		t.Fatal(e)
	}
	inbox, _ = s.Inbox(alice, now.Add(2*time.Minute))
	if len(inbox) != 1 || inbox[0].Title != "Updated" || inbox[0].ReadAt == nil {
		t.Fatalf("current validity/read receipt not honored: %+v", inbox)
	}
}

func TestAnnouncementAudienceIsRecheckedBeforeDeliveryAndCanBeRestored(t *testing.T) {
	s := notifications.New(repo(t), nil)
	now := time.Now().UTC()
	alice := notifications.Recipient{ID: "alice", Role: "user", Enabled: true}
	a := notifications.Announcement{ID: "pending-notice", Title: "Notice", Body: "Private message", Audience: "users", UserIDs: []string{"alice"}, StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Enabled: true}
	if e := s.SaveAnnouncement(a); e != nil {
		t.Fatal(e)
	}
	if e := s.Evaluate([]notifications.Recipient{alice}, nil, now); e != nil {
		t.Fatal(e)
	}
	a.Enabled = false
	if e := s.SaveAnnouncement(a); e != nil {
		t.Fatal(e)
	}
	if e := s.DeliverInApp(context.Background(), []notifications.Recipient{alice}, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ := s.Inbox(alice, now)
	if len(inbox) != 0 {
		t.Fatal("disabled announcement delivered")
	}
	out, _ := s.Outbox()
	if len(out) != 1 || out[0].Status != "cancelled" {
		t.Fatalf("pending event not cancelled: %+v", out)
	}
	a.Enabled = true
	if e := s.SaveAnnouncement(a); e != nil {
		t.Fatal(e)
	}
	if e := s.Evaluate([]notifications.Recipient{alice}, nil, now); e != nil {
		t.Fatal(e)
	}
	if e := s.DeliverInApp(context.Background(), []notifications.Recipient{alice}, now); e != nil {
		t.Fatal(e)
	}
	inbox, _ = s.Inbox(alice, now)
	if len(inbox) != 1 {
		t.Fatalf("restored eligible audience never receives notice: %+v", inbox)
	}
}
