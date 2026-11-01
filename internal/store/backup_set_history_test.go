package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestBackupSetFreshRestorePreservesSecretsIdentitiesIndexesCountersAndHistory(t *testing.T) {
	ctx := context.Background()
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{21}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.EnsureAdmin("operator", "synthetic-password-long"); err != nil {
		t.Fatal(err)
	}
	var account store.Account
	if err = source.Get("accounts", "admin", &account); err != nil {
		t.Fatal(err)
	}
	account.PendingTOTPSecret = "JBSWY3DPEHPK3PXP" // synthetic RFC-style MFA recovery fixture
	account.LastTOTPStep = 17
	if err = source.Put("accounts", "admin", account); err != nil {
		t.Fatal(err)
	}
	_, sessionToken, err := source.NewSession(account, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err = source.RecordUsage("admin", "batch1", 123); err != nil {
		t.Fatal(err)
	}
	fixtures := []struct {
		kind, id string
		value    any
	}{
		{"tenant/admin/sources", "source1", map[string]any{"id": "source1", "content": "socks5://secret:recovery-password@example.test:1080"}},
		{"tenant/admin/profile-revisions", "rev1", map[string]any{"id": "rev1", "profileId": "p1", "secret": "connection-secret"}},
		{"grants", "grant1", map[string]any{"userId": "admin", "routeId": "r1"}},
		{"ledger", "entry1", map[string]any{"userId": "admin", "rawBytes": 123, "weightedBytes": 246}},
		{"audit", "event1", map[string]any{"action": "published", "actorId": "admin"}},
	}
	for _, v := range fixtures {
		if err = source.Put(v.kind, v.id, v.value); err != nil {
			t.Fatal(err)
		}
	}
	if err = source.PutWithToken(store.TenantKind("admin", "outputs"), "output1", map[string]string{"id": "output1", "tokenDigest": "digest1", "token": "synthetic-published-feed-token"}, "feeds", "", "digest1", "admin/output1"); err != nil {
		t.Fatal(err)
	}
	if _, err = source.GenerateRecord("desired", "instance1", func(g uint64) (any, error) { return map[string]any{"generation": g}, nil }); err != nil {
		t.Fatal(err)
	}
	setPath := filepath.Join(t.TempDir(), "set")
	limits := backup.SetLimits{TotalBytes: 8 << 20, TotalRows: 1000, PartBytes: 64 << 10, PartRows: 2, RecordBytes: 32 << 10, Parts: 256, Duration: time.Minute, DiskBytes: 256 << 20}
	const password = "synthetic-offline-set-passphrase"
	if err = backup.CreateSet(ctx, source, password, setPath, limits); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{22}, 32)
	if err = backup.RestoreSet(ctx, setPath, password, target, key, limits); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if _, err = restored.Authenticate("operator", "synthetic-password-long", "", time.Now()); err != nil {
		t.Fatal("identity/password not preserved:", err)
	}
	var restoredAccount store.Account
	if err = restored.Get("accounts", "admin", &restoredAccount); err != nil || restoredAccount.PendingTOTPSecret != "JBSWY3DPEHPK3PXP" || restoredAccount.LastTOTPStep != 17 {
		t.Fatal("MFA recovery state not preserved")
	}
	if _, _, err = restored.ResolveSession(sessionToken, time.Now()); err != nil {
		t.Fatal("existing session lost:", err)
	}
	if err = restored.RecordUsage("admin", "batch1", 123); err != nil {
		t.Fatal("usage retry rejected:", err)
	}
	state, err := restored.State()
	if err != nil || len(state.Users) != 1 || state.Users[0].UsedBytes != 123 {
		t.Fatal("usage replay charged twice")
	}
	var output map[string]string
	if err = restored.TenantGet("admin", "outputs", "output1", &output); err != nil || output["token"] != "synthetic-published-feed-token" {
		t.Fatal("published feed credential lost")
	}
	for _, v := range fixtures {
		var got json.RawMessage
		if err = restored.Get(v.kind, v.id, &got); err != nil {
			t.Fatal(err)
		}
		want, _ := json.Marshal(v.value)
		if !bytes.Equal(got, want) {
			t.Fatalf("lost %s/%s", v.kind, v.id)
		}
	}
	if got, err := restored.LookupToken("feeds", "digest1"); err != nil || got != "admin/output1" {
		t.Fatalf("token index lost: %q %v", got, err)
	}
	if g, err := restored.GenerateRecord("desired", "instance1", func(g uint64) (any, error) { return map[string]any{"generation": g}, nil }); err != nil || g != 2 {
		t.Fatalf("generation lost: %d %v", g, err)
	}
	info, err := os.Stat(target)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe restored permissions: %v %v", info, err)
	}
	if err = backup.RestoreSet(ctx, setPath, password, target, key, limits); err == nil {
		t.Fatal("existing target overwritten")
	}
	if _, err = source.Authenticate("operator", "synthetic-password-long", "", time.Now()); err != nil {
		t.Fatal("source changed:", err)
	}
}
