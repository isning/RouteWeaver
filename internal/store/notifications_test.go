package store_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"testing"
)

func TestNotificationSecretPersistenceIsEncryptedAndNotOrdinaryState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "encrypted.db")
	key := bytes.Repeat([]byte{53}, 32)
	db, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	service := notifications.New(db, nil)
	settings, e := service.Settings()
	if e != nil {
		t.Fatal(e)
	}
	secret := "synthetic-only-webhook-secret-never-external"
	settings.Webhook = notifications.WebhookSettings{Enabled: true, URL: "https://notifications.example.com/events"}
	if _, e = service.SaveSettings(notifications.SettingsInput{Settings: settings.Settings, WebhookSecret: &secret}); e != nil {
		t.Fatal(e)
	}
	ordinary, e := db.State()
	if e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(ordinary)
	if bytes.Contains(body, []byte(secret)) {
		t.Fatal("secret appears in ordinary state")
	}
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	ciphertext, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(ciphertext, []byte(secret)) {
		t.Fatal("secret stored in plaintext database")
	}
	db, e = store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	view, e := notifications.New(db, nil).Settings()
	if e != nil || !view.WebhookSecretSet || view.Revision != 1 {
		t.Fatalf("secret presence lost after restart: %+v %v", view, e)
	}
	body, _ = json.Marshal(view)
	if bytes.Contains(body, []byte(secret)) {
		t.Fatal("write-only secret returned by settings API")
	}
}
