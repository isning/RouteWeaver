package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestBackupFreshRestorePreservesSecretsIdentitiesIndexesCountersAndHistory(t *testing.T) {
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
	snapshot, err := source.ExportSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{22}, 32)
	if err = store.RestoreFresh(ctx, target, key, snapshot); err != nil {
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
	if err = store.RestoreFresh(ctx, target, key, snapshot); err == nil {
		t.Fatal("existing target overwritten")
	}
	if _, err = source.Authenticate("operator", "synthetic-password-long", "", time.Now()); err != nil {
		t.Fatal("source changed:", err)
	}
}

func TestBackupRejectsInvalidOrOccupiedTargetBeforeMutation(t *testing.T) {
	ctx := context.Background()
	key := bytes.Repeat([]byte{27}, 32)
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.EnsureAdmin("operator", "synthetic-long-password"); err != nil {
		t.Fatal(err)
	}
	snap, err := source.ExportSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*store.Snapshot)
	}{
		{"unsupported schema", func(s *store.Snapshot) { s.SchemaVersion++ }},
		{"missing identity", func(s *store.Snapshot) { s.Identities = nil }},
		{"duplicate record", func(s *store.Snapshot) { s.Records = append(s.Records, s.Records[0]) }},
		{"missing migration", func(s *store.Snapshot) { s.Migrations = s.Migrations[:1] }},
		{"orphan token", func(s *store.Snapshot) {
			s.Tokens = append(s.Tokens, store.BackupToken{Kind: "feeds", Digest: "unknown", RecordID: "admin/missing"})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bad store.Snapshot
			b, _ := json.Marshal(snap)
			json.Unmarshal(b, &bad)
			tc.change(&bad)
			target := filepath.Join(t.TempDir(), "bad.db")
			if err := store.RestoreFresh(ctx, target, key, bad); err == nil {
				t.Fatal("bad snapshot restored")
			}
			if _, err := os.Lstat(target); !os.IsNotExist(err) {
				t.Fatal("invalid archive mutated target")
			}
		})
	}
	occupied, err := store.Open(filepath.Join(t.TempDir(), "occupied.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	if err = occupied.Put("sentinel", "existing", map[string]bool{"keep": true}); err != nil {
		t.Fatal(err)
	}
	if err = occupied.ImportSnapshot(ctx, snap); err == nil {
		t.Fatal("occupied store overwritten")
	}
	var existing map[string]bool
	if err = occupied.Get("sentinel", "existing", &existing); err != nil || !existing["keep"] {
		t.Fatal("prior state lost")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	target := filepath.Join(t.TempDir(), "cancelled.db")
	if err = store.RestoreFresh(cancelled, target, key, snap); err == nil {
		t.Fatal("cancel ignored")
	}
	if _, err = os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("cancelled restore published")
	}
	sentinel := filepath.Join(t.TempDir(), "sentinel")
	if err = os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link.db")
	if err = os.Symlink(sentinel, link); err != nil {
		t.Fatal(err)
	}
	if err = store.RestoreFresh(ctx, link, key, snap); err == nil {
		t.Fatal("symlink target followed")
	}
	got, _ := os.ReadFile(sentinel)
	if string(got) != "keep" {
		t.Fatal("symlink destination overwritten")
	}
}

func TestBackupImportRollsBackPartialDatabaseFailure(t *testing.T) {
	ctx := context.Background()
	key := bytes.Repeat([]byte{29}, 32)
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err = source.EnsureAdmin("operator", "synthetic-long-password"); err != nil {
		t.Fatal(err)
	}
	if err = source.Put("ledger", "entry1", map[string]int{"bytes": 123}); err != nil {
		t.Fatal(err)
	}
	snap, err := source.ExportSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "target.db")
	target, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	// Fault fixture at the actual SQLite adapter: fail after account insertion.
	fault, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`CREATE TRIGGER reject_restore BEFORE INSERT ON records WHEN NEW.kind='ledger' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = target.ImportSnapshot(ctx, snap); err == nil {
		t.Fatal("injected adapter failure ignored")
	}
	empty, err := target.ExportSnapshot(ctx)
	if err != nil || len(empty.Records) != 1 || len(empty.Identities) != 0 {
		t.Fatalf("partial restore escaped rollback: %#v %v", empty, err)
	}
	if _, err = target.Authenticate("operator", "synthetic-long-password", "", time.Now()); err == nil {
		t.Fatal("partial account became usable")
	}
	if _, err = fault.Exec(`DROP TRIGGER reject_restore`); err != nil {
		t.Fatal(err)
	}
	if err = target.ImportSnapshot(ctx, snap); err != nil {
		t.Fatal("retry after rollback:", err)
	}
	if _, err = target.Authenticate("operator", "synthetic-long-password", "", time.Now()); err != nil {
		t.Fatal("retry did not restore identity:", err)
	}
}

func TestBackupSnapshotIsAtomicAcrossRecordAndGeneration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{34}, 32)
	reader, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	writer, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 40; i++ {
			_, err := writer.GenerateRecord("desired", "instance1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil })
			if err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 30; i++ {
		snap, err := reader.ExportSnapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var counter int64
		for _, c := range snap.Counters {
			if c.Kind == "desired" && c.ID == "instance1" {
				counter = c.Value
			}
		}
		for _, r := range snap.Records {
			if r.Kind == "desired" && r.ID == "instance1" {
				var got struct {
					Generation int64 `json:"generation"`
				}
				if err = json.Unmarshal(r.Data, &got); err != nil {
					t.Fatal(err)
				}
				if got.Generation != counter {
					t.Fatalf("torn snapshot: record %d, counter %d", got.Generation, counter)
				}
			}
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestBackupRefusesUnknownDatabaseTablesRatherThanOmittingThem(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	s, err := store.Open(path, bytes.Repeat([]byte{35}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fixture, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()
	if _, err = fixture.Exec(`CREATE TABLE future_data(secret TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ExportSnapshot(context.Background()); err == nil {
		t.Fatal("unknown table silently omitted from backup")
	}
}

func TestBackupPreservesGenerationFenceAfterCurrentRecordRemoval(t *testing.T) {
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{37}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if _, err = source.GenerateRecord("desired", "removed", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); err != nil {
		t.Fatal(err)
	}
	if err = source.Remove("desired", "removed"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal("generation tombstone must be recoverable:", err)
	}
	target, err := store.Open(filepath.Join(t.TempDir(), "target.db"), bytes.Repeat([]byte{38}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	if err = target.ImportSnapshot(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	generation, err := target.GenerateRecord("desired", "removed", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil })
	if err != nil || generation != 2 {
		t.Fatalf("removed record reused a generation: %d %v", generation, err)
	}
}

func TestBackupRefusesUnknownColumnsRatherThanLosingFutureState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	s, err := store.Open(path, bytes.Repeat([]byte{39}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fixture, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fixture.Close()
	if _, err = fixture.Exec(`ALTER TABLE counters ADD COLUMN future_fence TEXT`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ExportSnapshot(context.Background()); err == nil {
		t.Fatal("new schema column silently omitted")
	}
}

func TestBackupStreamingReadTransactionPreservesGenerationAndRejectsCancelledImport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{75}, 32)
	reader, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	writer, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	limits := store.BackupLimits{MaxBytes: 32 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 40; i++ {
			if _, e := writer.GenerateRecord("agent-desired", "core1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); e != nil {
				done <- e
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 20; i++ {
		var generation, counter uint64
		err = reader.ExportBackup(context.Background(), limits, func(f store.BackupFrame) error {
			if f.Record != nil && f.Record.Kind == "agent-desired" {
				var v struct{ Generation uint64 }
				if e := json.Unmarshal(f.Record.Data, &v); e != nil {
					return e
				}
				generation = v.Generation
			}
			if f.Counter != nil && f.Counter.Kind == "agent-desired" {
				counter = uint64(f.Counter.Value)
			}
			return nil
		})
		if err != nil || generation != counter {
			t.Fatalf("torn streaming transaction:%d %d %v", generation, counter, err)
		}
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	target, err := store.Open(filepath.Join(t.TempDir(), "fresh.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	ctx, cancel := context.WithCancel(context.Background())
	err = target.ImportBackup(ctx, limits, func(emit func(store.BackupFrame) error) error {
		return reader.ExportBackup(context.Background(), limits, func(f store.BackupFrame) error {
			if e := emit(f); e != nil {
				return e
			}
			cancel()
			return ctx.Err()
		})
	})
	if err == nil {
		t.Fatal("cancelled import accepted")
	}
	snapshot, err := target.ExportSnapshot(context.Background())
	if err != nil || len(snapshot.Records) != 1 || len(snapshot.Counters) != 0 {
		t.Fatalf("partial cancelled import escaped:%+v %v", snapshot, err)
	}
}
