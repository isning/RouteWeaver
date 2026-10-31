package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestBackupStreamingInsertReuseRollsBackAndRetries(t *testing.T) {
	ctx := context.Background()
	limits := store.BackupLimits{MaxBytes: 16 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}
	key := bytes.Repeat([]byte{83}, 32)
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	const password = "synthetic-stream-reuse-password"
	if err = source.EnsureAdmin("operator", password); err != nil {
		t.Fatal(err)
	}
	_, invitation, err := source.CreateInvite("Second account", "user", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.AcceptInvite(invitation, "second-user", password); err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"feed-a", "feed-longer-b"} {
		digest := "synthetic-digest-" + id
		if err = source.PutWithToken("tenant/admin/outputs", id, map[string]string{"status": "published", "tokenDigest": digest, "token": "synthetic-token-" + id}, "feeds", "", digest, "admin/"+id); err != nil {
			t.Fatal(err)
		}
		for j := 0; j <= i; j++ {
			if _, err = source.GenerateRecord("agent-desired", id, func(g uint64) (any, error) {
				return map[string]uint64{"generation": g}, nil
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, id := range []string{"entry-a", "entry-b"} {
		if err = source.Put("ledger", id, map[string]string{"value": id}); err != nil {
			t.Fatal(err)
		}
	}
	// Encode inside the callback: ExportBackup clears record data on return.
	export := func(s *store.Store) ([]byte, [5]int) {
		t.Helper()
		var b bytes.Buffer
		var counts [5]int
		enc := json.NewEncoder(&b)
		if e := s.ExportBackup(ctx, limits, func(f store.BackupFrame) error {
			switch {
			case f.Record != nil:
				counts[0]++
			case f.Identity != nil:
				counts[1]++
			case f.Token != nil:
				counts[2]++
			case f.Counter != nil:
				counts[3]++
			case f.Migration != nil:
				counts[4]++
			}
			return enc.Encode(f)
		}); e != nil {
			t.Fatal(e)
		}
		return b.Bytes(), counts
	}
	want, counts := export(source)
	for table, count := range counts {
		if count < 2 {
			t.Fatalf("fixture must reuse every insert: table %d has %d rows", table, count)
		}
	}
	path := filepath.Join(t.TempDir(), "target.db")
	target, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	fresh, _ := export(target)
	fault, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`CREATE TRIGGER reject_stream_restore BEFORE INSERT ON records WHEN NEW.kind='ledger' AND NEW.id='entry-b' BEGIN SELECT RAISE(ABORT,'synthetic stream insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	emitted := 0
	produce := func(emit func(store.BackupFrame) error) error {
		return source.ExportBackup(ctx, limits, func(f store.BackupFrame) error {
			if e := emit(f); e != nil {
				return e
			}
			emitted++
			return nil
		})
	}
	err = target.ImportBackup(ctx, limits, produce)
	if err == nil || !strings.Contains(err.Error(), "synthetic stream insert failure") || emitted < 2 {
		t.Fatalf("expected adapter failure after repeated inserts: emitted=%d err=%v", emitted, err)
	}
	afterFailure, _ := export(target)
	if !bytes.Equal(fresh, afterFailure) {
		t.Fatal("failed streaming import changed fresh target")
	}
	if _, err = target.Authenticate("operator", password, "", time.Now()); err == nil {
		t.Fatal("failed streaming import made partial account usable")
	}
	if _, err = fault.Exec(`DROP TRIGGER reject_stream_restore`); err != nil {
		t.Fatal(err)
	}
	if err = target.ImportBackup(ctx, limits, produce); err != nil {
		t.Fatal("retry on same Store after rollback:", err)
	}
	got, _ := export(target)
	if !bytes.Equal(want, got) {
		t.Fatal("streaming retry changed records, identities, tokens, counters, or migrations")
	}
	for _, username := range []string{"operator", "second-user"} {
		if _, err = target.Authenticate(username, password, "", time.Now()); err != nil {
			t.Fatalf("restored identity %s unavailable: %v", username, err)
		}
	}
}
