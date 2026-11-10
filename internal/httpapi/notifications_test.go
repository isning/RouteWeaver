package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/notifications"
	"strings"
	"testing"
	"time"
)

func adminNotificationRequest(t *testing.T, url, method string, v any) (int, []byte) {
	t.Helper()
	var body io.Reader
	if v != nil {
		b, _ := json.Marshal(v)
		body = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, url, body)
	r.Header.Set("Authorization", "Bearer 012345678901234567890123456789012345")
	r.Header.Set("Content-Type", "application/json")
	res, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	return res.StatusCode, b
}
func TestNotificationHTTPAudienceReadAndSettingsIsolation(t *testing.T) {
	s, srv := makeServer(t)
	alice := inviteClient(t, s, srv, "alice")
	bob := inviteClient(t, s, srv, "bob")
	now := time.Now().UTC()
	announcement := notifications.Announcement{ID: "scheduled-work", Title: "Planned maintenance", Body: "Private announcement for Alice", Audience: "users", UserIDs: []string{alice.id}, StartsAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Enabled: true}
	code, raw := adminNotificationRequest(t, srv.URL+"/api/admin/announcements", "POST", announcement)
	if code != 200 {
		t.Fatalf("publish: %d %s", code, raw)
	}
	// A saved schedule is not delivery. Reading the inbox cannot replace the
	// background worker, even for an immediately active announcement.
	beforeCode, _, beforeBody := req(t, alice.c, "GET", srv.URL+"/api/me/notifications", "", nil)
	var before []notifications.InboxItem
	if beforeCode != 200 || json.Unmarshal([]byte(beforeBody), &before) != nil || len(before) != 0 {
		t.Fatalf("announcement became available without worker delivery: %d %s", beforeCode, beforeBody)
	}
	if _, err := httpapi.RunNotificationBatch(context.Background(), s, "", now); err != nil {
		t.Fatal(err)
	}
	code, _, text := req(t, alice.c, "GET", srv.URL+"/api/me/notifications", "", nil)
	var inbox []notifications.InboxItem
	if json.Unmarshal([]byte(text), &inbox) != nil || code != 200 || len(inbox) != 1 {
		t.Fatalf("inbox: %d %s", code, text)
	}
	code, _, text = req(t, bob.c, "GET", srv.URL+"/api/me/notifications", "", nil)
	if code != 200 || strings.Contains(text, "Private announcement") {
		t.Fatalf("private inbox leaked: %d %s", code, text)
	}
	code, _, text = req(t, bob.c, "POST", srv.URL+"/api/me/notifications/"+inbox[0].EventID+"/read", bob.csrf, nil)
	if code != 404 {
		t.Fatalf("read IDOR: %d %s", code, text)
	}
	code, _, text = req(t, alice.c, "POST", srv.URL+"/api/me/notifications/"+inbox[0].EventID+"/read", alice.csrf, nil)
	if code != 200 {
		t.Fatalf("read: %d %s", code, text)
	}
	code, _, text = req(t, alice.c, "GET", srv.URL+"/api/me/notifications", "", nil)
	json.Unmarshal([]byte(text), &inbox)
	if inbox[0].ReadAt == nil {
		t.Fatal("missing read receipt")
	}
	code, _, text = req(t, bob.c, "GET", srv.URL+"/api/admin/notification-settings", "", nil)
	if code != 403 {
		t.Fatalf("settings RBAC: %d %s", code, text)
	}
	code, raw = adminNotificationRequest(t, srv.URL+"/api/admin/notification-settings", "GET", nil)
	var initial notifications.SettingsView
	if code != 200 || json.Unmarshal(raw, &initial) != nil {
		t.Fatalf("settings: %d %s", code, raw)
	}
	secret := "synthetic-test-signing-secret-1234567890"
	input := notifications.SettingsInput{Settings: initial.Settings, WebhookSecret: &secret}
	input.Webhook.URL = "https://notifications.example.com/events"
	input.Webhook.Enabled = true
	code, raw = adminNotificationRequest(t, srv.URL+"/api/admin/notification-settings", "PUT", input)
	if code != 200 || strings.Contains(string(raw), secret) {
		t.Fatalf("save secret: %d %s", code, raw)
	}
	var saved notifications.SettingsView
	json.Unmarshal(raw, &saved)
	if !saved.WebhookSecretSet || saved.Revision != 1 {
		t.Fatalf("effective settings: %s", raw)
	}
	// Failed edits cannot erase the previously effective destination or secret.
	bad := notifications.SettingsInput{Settings: saved.Settings}
	bad.Webhook.URL = "https://127.0.0.1/private"
	empty := ""
	bad.WebhookSecret = &empty
	code, _ = adminNotificationRequest(t, srv.URL+"/api/admin/notification-settings", "PUT", bad)
	if code != 400 {
		t.Fatalf("invalid setting accepted: %d", code)
	}
	code, raw = adminNotificationRequest(t, srv.URL+"/api/admin/notification-settings", "GET", nil)
	if code != 200 || strings.Contains(string(raw), "127.0.0.1") || strings.Contains(string(raw), secret) {
		t.Fatalf("effective setting damaged/leaked: %d %s", code, raw)
	}
	for _, path := range []string{"/api/state", "/api/audit", "/api/admin/notifications/outbox"} {
		code, raw = adminNotificationRequest(t, srv.URL+path, "GET", nil)
		if code != 200 || strings.Contains(string(raw), secret) {
			t.Fatalf("secret leaked via %s: %d %s", path, code, raw)
		}
	}
	code, raw = adminNotificationRequest(t, srv.URL+"/api/admin/notifications/test", "POST", map[string]string{"channel": "in-app"})
	if code != 200 || !bytes.Contains(raw, []byte(`"status":"available"`)) {
		t.Fatalf("explicit in-app test: %d %s", code, raw)
	}
	// No external test or recipient is used in this test. Saving alone queues none.
	code, raw = adminNotificationRequest(t, srv.URL+"/api/admin/notifications/outbox", "GET", nil)
	var out []notifications.OutboxItem
	json.Unmarshal(raw, &out)
	for _, d := range out {
		if d.Channel != "in-app" {
			t.Fatalf("save implicitly queued external delivery: %s", raw)
		}
	}
}

func TestNotificationHTTPRejectsStaleReviewedExternalSettings(t *testing.T) {
	s, srv := makeServer(t)
	n := notifications.New(s, nil)
	current, err := n.Settings()
	if err != nil {
		t.Fatal(err)
	}
	stale := current.Revision + 1
	// Channel remains disabled: revision conflict must be checked before enqueue
	// or channel use. This test cannot invoke any external transport.
	for _, channel := range []string{"email", "webhook"} {
		code, raw := adminNotificationRequest(t, srv.URL+"/api/admin/notifications/test", "POST", map[string]any{"channel": channel, "expectedSettingsRevision": stale})
		if code != 409 {
			t.Fatalf("%s stale decision: %d %s", channel, code, raw)
		}
	}
	state, err := s.ReadNotifications()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Events) != 0 || len(state.Deliveries) != 0 {
		t.Fatal("rejected test created work")
	}
	code, raw := adminNotificationRequest(t, srv.URL+"/api/admin/notifications/test", "POST", map[string]any{"channel": "in-app", "expectedSettingsRevision": stale})
	if code != 200 || !bytes.Contains(raw, []byte(`"status":"available"`)) {
		t.Fatalf("in-app test unexpectedly blocked: %d %s", code, raw)
	}
}
