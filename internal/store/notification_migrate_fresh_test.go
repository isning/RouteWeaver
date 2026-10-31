//go:build linux || darwin

package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
)

func notificationMigrationFixture(t *testing.T, keepOpen bool) (string, []byte, notifications.State) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.db")
	key := bytes.Repeat([]byte{81}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	state := notifications.DefaultState()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	state.Secrets.SMTPPassword = "synthetic-preserved-secret"
	state.Events["event"] = notifications.Event{EventID: "event", RecipientID: "alice", Kind: "quota", Title: "History", Body: "Keep the accepted payload", CreatedAt: now}
	state.Deliveries["event/in-app"] = notifications.Delivery{EventID: "event", Channel: "in-app", Status: "available", CreatedAt: now}
	state.Deliveries["event/email"] = notifications.Delivery{EventID: "event", Channel: "email", Status: "sending", Attempts: 2, CreatedAt: now, LeaseToken: "preserved-lease", LeaseUntil: now.Add(time.Minute), SettingsRevision: 3}
	state.Reads["alice/event"] = now
	if err = s.Put("notification-private", "state", state); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("audit", "original", map[string]string{"action": "keep"}); err != nil {
		t.Fatal(err)
	}
	if keepOpen {
		t.Cleanup(func() { s.Close() })
	} else if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	return path, key, state
}
func migrationContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	return ctx
}
func migrationSourceBytes(t *testing.T, path string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, name := range []string{path, path + "-wal"} {
		b, err := os.ReadFile(name)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		out[name] = b
	}
	return out
}
func assertMigrationSourceUnchanged(t *testing.T, before map[string][]byte) {
	t.Helper()
	for path, want := range before {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(want, got) {
			t.Fatalf("source database/WAL changed: %s (%v)", path, err)
		}
	}
}
func assertNoMigrationOutput(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("unexpected migration output: %v", err)
	}
	for _, pattern := range []string{".notification-migrate-*", ".restore-*"} {
		files, err := filepath.Glob(filepath.Join(filepath.Dir(path), pattern))
		if err != nil || len(files) != 0 {
			t.Fatalf("owned temporary files leaked: %v %v", files, err)
		}
	}
}
func TestOfflineNotificationMigrationPublishesFreshVerifiedCopy(t *testing.T) {
	for _, wal := range []bool{false, true} {
		t.Run(map[bool]string{false: "checkpointed", true: "WAL"}[wal], func(t *testing.T) {
			source, key, want := notificationMigrationFixture(t, wal)
			if wal {
				info, err := os.Stat(source + "-wal")
				if err != nil || info.Size() == 0 {
					t.Fatalf("fixture must retain committed WAL: %v", err)
				}
			}
			before := migrationSourceBytes(t, source)
			output := filepath.Join(t.TempDir(), "migrated.db")
			if err := store.MigrateNotificationsFresh(migrationContext(t), source, output, key, 1<<20); err != nil {
				t.Fatal(err)
			}
			assertMigrationSourceUnchanged(t, before)
			s, err := store.Open(output, key)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			got, err := s.ReadNotifications()
			if err != nil || !reflect.DeepEqual(want, got) {
				t.Fatalf("accepted facts changed: %+v %v", got, err)
			}
			var legacy json.RawMessage
			if err = s.Get("notification-private", "state", &legacy); err != store.ErrNotFound {
				t.Fatalf("legacy representation remains: %v", err)
			}
			var audit map[string]string
			if err = s.Get("audit", "original", &audit); err != nil || audit["action"] != "keep" {
				t.Fatalf("non-notification fact lost: %v %v", audit, err)
			}
		})
	}
}
func TestOfflineNotificationMigrationRejectsAliasesAndHeldProcessLock(t *testing.T) {
	source, key, _ := notificationMigrationFixture(t, false)
	before := migrationSourceBytes(t, source)
	symlink := filepath.Join(t.TempDir(), "source-link")
	if err := os.Symlink(source, symlink); err != nil {
		t.Fatal(err)
	}
	hardlink := filepath.Join(t.TempDir(), "source-hardlink")
	if err := os.Link(source, hardlink); err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{source, symlink, hardlink} {
		if err := store.MigrateNotificationsFresh(migrationContext(t), source, output, key, 1<<20); err == nil {
			t.Fatal("existing/alias output accepted")
		}
	}
	release, err := store.AcquireDatabaseProcessLock(source)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, input := range []string{source, symlink, hardlink} {
		output := filepath.Join(t.TempDir(), "output.db")
		if err = store.MigrateNotificationsFresh(migrationContext(t), input, output, key, 1<<20); err == nil {
			t.Fatal("held source inode lock bypassed")
		}
		assertNoMigrationOutput(t, output)
	}
	assertMigrationSourceUnchanged(t, before)
}
func TestOfflineNotificationMigrationFailuresDoNotPublishOrChangeSource(t *testing.T) {
	for _, failure := range []string{"budget", "key", "schema", "migration", "cancelled", "no-deadline", "missing-source", "dangling-output"} {
		t.Run(failure, func(t *testing.T) {
			source, key, state := notificationMigrationFixture(t, false)
			output := filepath.Join(t.TempDir(), "output.db")
			limit := int64(1 << 20)
			ctx := migrationContext(t)
			switch failure {
			case "budget":
				raw, _ := json.Marshal(state)
				limit = int64(len(raw) - 1)
			case "key":
				key = bytes.Repeat([]byte{82}, 32)
			case "schema", "migration":
				db, err := sql.Open("sqlite", source)
				if err != nil {
					t.Fatal(err)
				}
				mutation := `CREATE TABLE future_data(id TEXT)`
				if failure == "migration" {
					mutation = `CREATE TRIGGER fail_notification_copy BEFORE INSERT ON records WHEN NEW.kind='notification-events' BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END`
				}
				if _, err = db.Exec(mutation); err != nil {
					t.Fatal(err)
				}
				if err = db.Close(); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "no-deadline":
				ctx = context.Background()
			case "missing-source":
				source = filepath.Join(t.TempDir(), "missing.db")
			case "dangling-output":
				if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), output); err != nil {
					t.Fatal(err)
				}
			}
			before := migrationSourceBytes(t, source)
			if err := store.MigrateNotificationsFresh(ctx, source, output, key, limit); err == nil {
				t.Fatal("unsafe migration accepted")
			}
			assertMigrationSourceUnchanged(t, before)
			if failure == "dangling-output" {
				info, err := os.Lstat(output)
				if err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatal("occupied output changed")
				}
			} else {
				assertNoMigrationOutput(t, output)
			}
			if failure == "missing-source" {
				if _, err := os.Stat(source); !os.IsNotExist(err) {
					t.Fatal("missing source was created")
				}
			}
		})
	}
}

func TestOfflineNotificationMigrationRejectsSQLitePathFamilyCollisions(t *testing.T) {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		t.Run(suffix, func(t *testing.T) {
			source, key, _ := notificationMigrationFixture(t, false)
			before := migrationSourceBytes(t, source)
			if err := store.MigrateNotificationsFresh(migrationContext(t), source, source+suffix, key, 1<<20); err == nil {
				t.Fatal("source SQLite-owned path accepted as output")
			}
			assertNoMigrationOutput(t, source+suffix)
			target := filepath.Join(t.TempDir(), "output.db")
			sidecar := []byte("existing caller-owned sidecar")
			if err := os.WriteFile(target+suffix, sidecar, 0600); err != nil {
				t.Fatal(err)
			}
			if err := store.MigrateNotificationsFresh(migrationContext(t), source, target, key, 1<<20); err == nil {
				t.Fatal("occupied output sidecar accepted")
			}
			assertNoMigrationOutput(t, target)
			got, err := os.ReadFile(target + suffix)
			if err != nil || !bytes.Equal(got, sidecar) {
				t.Fatal("caller-owned sidecar changed")
			}
			assertMigrationSourceUnchanged(t, before)
		})
	}
}
func TestOfflineNotificationMigrationRejectsValidStaleWAL(t *testing.T) {
	source, key, _ := notificationMigrationFixture(t, false)
	target := filepath.Join(t.TempDir(), "output.db")
	old, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = old.Put("audit", "foreign", map[string]string{"action": "foreign-state"}); err != nil {
		t.Fatal(err)
	}
	wal, err := os.ReadFile(target + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target+"-wal", wal, 0600); err != nil {
		t.Fatal(err)
	}
	if err = store.MigrateNotificationsFresh(migrationContext(t), source, target, key, 1<<20); err == nil {
		t.Fatal("valid foreign WAL admitted beside new output")
	}
	assertNoMigrationOutput(t, target)
	got, err := os.ReadFile(target + "-wal")
	if err != nil || !bytes.Equal(got, wal) {
		t.Fatal("foreign WAL changed on refusal")
	}
}
