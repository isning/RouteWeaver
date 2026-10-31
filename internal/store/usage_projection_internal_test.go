package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/service"
)

func projectionTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "state.db"), bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func projectionTestRead(t *testing.T, s *Store, account string) service.UsageTotals {
	t.Helper()
	tx, err := s.beginWriteTx()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	totals, err := s.currentUsageTx(tx, account, time.Time{}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return totals
}
func projectionTestClean(t *testing.T, s *Store) {
	t.Helper()
	var generation, ack int64
	if err := s.db.QueryRow(`SELECT generation,acknowledged FROM usage_projection_state WHERE id=1`).Scan(&generation, &ack); err != nil {
		t.Fatal(err)
	}
	if generation != ack {
		t.Fatalf("normal writer left fallback dirty: %d != %d", generation, ack)
	}
}
func TestUsageProjectionNormalMutationSeamsStayIncremental(t *testing.T) {
	s := projectionTestStore(t)
	at := time.Now().UTC()
	record := MeterRecord{MeterBatch: MeterBatch{UserID: "account", RawBytes: 3, ProviderBytes: 5, ObservedAt: at}, RateMicros: 333333}
	projectionTestRead(t, s, "account")
	operations := []struct {
		name string
		run  func() error
	}{
		{"put", func() error { return s.Put("ledger", "put", record) }},
		{"replace", func() error { return s.Put("ledger", "put", record) }},
		{"immutable", func() error { return s.PutImmutable("ledger", "immutable", record) }},
		{"immutable-replay", func() error { return s.PutImmutable("ledger", "immutable", record) }},
		{"update-records", func() error {
			return s.UpdateRecords("ledger", "put", func(json.RawMessage) ([]RecordWrite, error) { return []RecordWrite{{"ledger", "update", record}}, nil })
		}},
		{"generate", func() error {
			_, err := s.GenerateRecord("ledger", "generated", func(uint64) (any, error) { return record, nil })
			return err
		}},
		{"cas", func() error { return s.CompareAndPutRecords(nil, []RecordWrite{{"ledger", "cas", record}}) }},
		{"set-cas", func() error {
			return s.CompareSetsAndPutRecords(nil, nil, []RecordWrite{{"ledger", "set-cas", record}})
		}},
		{"set-generate", func() error {
			_, err := s.CompareSetsAndGenerateRecord("ledger", "set-generated", nil, nil, func(uint64) (any, []RecordWrite, error) {
				return record, []RecordWrite{{"ledger", "associated", record}}, nil
			})
			return err
		}},
		{"token", func() error {
			return s.PutWithToken("ledger", "token", record, "projection-tokens", "", "digest", "token")
		}},
		{"token-cas", func() error {
			return s.CompareInputsAndPutWithToken("ledger", "token", record, record, "projection-tokens", "digest", "next", "token", nil, nil)
		}},
		{"delete", func() error { return s.Remove("ledger", "put") }},
	}
	for _, op := range operations {
		t.Run(op.name, func(t *testing.T) {
			if err := op.run(); err != nil {
				t.Fatal(err)
			}
			projectionTestClean(t, s) // Before the read: fallback must not mask missed plumbing.
			got := projectionTestRead(t, s, "account")
			want, err := s.Usage("account", time.Time{}, time.Time{})
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("projection %+v canonical %+v", got, want)
			}
		})
	}
	if err := s.PutUser(domain.User{ID: "account", Name: "Account", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMeter(MeterBatch{UserID: "account", RouteID: "route", MeterID: "meter", Epoch: "epoch", Sequence: 1, RawBytes: 1, ObservedAt: at}); err != nil {
		t.Fatal(err)
	}
	projectionTestClean(t, s)
}

func TestUsageProjectionFailedTransactionRollsBackCanonicalAndDerived(t *testing.T) {
	s := projectionTestStore(t)
	projectionTestRead(t, s, "account")
	old := projectionTestRead(t, s, "account")
	err := s.CompareAndPutRecords(nil, []RecordWrite{
		{"ledger", "first", MeterRecord{MeterBatch: MeterBatch{UserID: "account", RawBytes: 17}, RateMicros: service.RateScale}},
		{"invalid", "marshal", make(chan int)},
	})
	if err == nil {
		t.Fatal("expected rejected transaction")
	}
	projectionTestClean(t, s)
	if got := projectionTestRead(t, s, "account"); got != old {
		t.Fatalf("failed write charged %+v", got)
	}
	var value MeterRecord
	if err = s.Get("ledger", "first", &value); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial canonical write: %v", err)
	}
}

func TestUsageProjectionAccountCiphertextSwapRebuilds(t *testing.T) {
	s := projectionTestStore(t)
	for account, raw := range map[string]int64{"alice": 3, "bob": 17} {
		if err := s.Put("ledger", account, MeterRecord{MeterBatch: MeterBatch{UserID: account, RawBytes: raw}, RateMicros: service.RateScale}); err != nil {
			t.Fatal(err)
		}
		projectionTestRead(t, s, account)
	}
	alice, _ := s.usageAccountToken("alice")
	bob, _ := s.usageAccountToken("bob")
	if _, err := s.db.Exec(`UPDATE usage_windows SET data=(SELECT data FROM usage_windows WHERE account=?) WHERE account=?`, alice, bob); err != nil {
		t.Fatal(err)
	}
	if got := projectionTestRead(t, s, "bob"); got.RawBytes != 17 {
		t.Fatalf("wrong-account ciphertext trusted: %+v", got)
	}
}

func TestUsageProjectionBackupDoesNotRepairOrExportDerivedState(t *testing.T) {
	s := projectionTestStore(t)
	if err := s.Put("ledger", "a", MeterRecord{MeterBatch: MeterBatch{UserID: "account", RawBytes: 2}, RateMicros: service.RateScale}); err != nil {
		t.Fatal(err)
	}
	projectionTestRead(t, s, "account")
	before, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Export must not opportunistically clear dirty state or repair bad ciphertext.
	if _, err = s.db.Exec(`UPDATE usage_projection_state SET generation=generation+1; UPDATE usage_windows SET data=X'00'`); err != nil {
		t.Fatal(err)
	}
	after, err := s.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("derived state changed canonical snapshot")
	}
	if err = s.ExportBackup(context.Background(), BackupLimits{MaxBytes: 16 << 20, MaxRows: 10000, MaxRecordBytes: 1 << 20}, func(BackupFrame) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var data []byte
	var dirty int
	if err = s.db.QueryRow(`SELECT data FROM usage_windows`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow(`SELECT generation!=acknowledged FROM usage_projection_state WHERE id=1`).Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, []byte{0}) || dirty != 1 {
		t.Fatal("read-only backup repaired derived state")
	}
}

func TestUsageProjectionMissingTriggerFailsClosedUntilReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	key := bytes.Repeat([]byte{19}, 32)
	s, err := Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	projectionTestRead(t, s, "account")
	if _, err = s.db.Exec(`DROP TRIGGER usage_ledger_insert`); err != nil {
		t.Fatal(err)
	}
	encrypted, err := s.seal("ledger", "bypass", MeterRecord{MeterBatch: MeterBatch{UserID: "account", RawBytes: 13}, RateMicros: service.RateScale})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`INSERT INTO records(kind,id,data) VALUES('ledger','bypass',?)`, encrypted); err != nil {
		t.Fatal(err)
	}
	tx, err := s.beginWriteTx()
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.currentUsageTx(tx, "account", time.Time{}, time.Time{})
	tx.Rollback()
	if err == nil {
		t.Fatal("missing trigger let stale warm total authorize a read")
	}
	s.Close()
	s, err = Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	if got := projectionTestRead(t, s, "account"); got.RawBytes != 13 {
		t.Fatalf("reopen did not recover canonical usage: %+v", got)
	}
}

func TestUsageProjectionRowKeysAreSeparatelyKeyedAndContextRequired(t *testing.T) {
	s := projectionTestStore(t)
	projectionTestRead(t, s, "sensitive-account-name")
	var token string
	if err := s.db.QueryRow(`SELECT account FROM usage_windows`).Scan(&token); err != nil {
		t.Fatal(err)
	}
	if token == "sensitive-account-name" || len(token) != 64 {
		t.Fatalf("account identifier exposed: %q", token)
	}
	other := projectionTestStore(t)
	same, err := other.usageAccountToken("sensitive-account-name")
	if err != nil {
		t.Fatal(err)
	}
	if same != token {
		t.Fatal("same master key did not yield stable lookup identity")
	}
	old := s.usageLookupKey
	s.usageLookupKey = nil
	if err = s.Put("ledger", "missing-context", MeterRecord{}); err == nil {
		t.Fatal("missing context silently accepted tracked write")
	}
	s.usageLookupKey = old
	var record MeterRecord
	if err = s.Get("ledger", "missing-context", &record); !errors.Is(err, ErrNotFound) {
		t.Fatal("failed crypto initialization published canonical write")
	}
}
