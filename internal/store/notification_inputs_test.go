package store_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestNotificationInputsMatchAuthoritativeUsageWindows(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for _, id := range []string{"alice", "bob"} {
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: true, QuotaBytes: 1000}); err != nil {
			t.Fatal(err)
		}
	}
	records := []store.RecordWrite{}
	for i, owner := range []string{"alice", "alice", "bob"} {
		r := store.MeterRecord{MeterBatch: store.MeterBatch{UserID: owner, RawBytes: 1, ProviderBytes: 2, ObservedAt: now.Add(-time.Hour)}, RateMicros: 333333}
		records = append(records, store.RecordWrite{Kind: "ledger", ID: string(rune('a' + i)), Value: r})
	}
	// Future observations must not enter the current notification's usage.
	records = append(records, store.RecordWrite{Kind: "ledger", ID: "future", Value: store.MeterRecord{MeterBatch: store.MeterBatch{UserID: "alice", RawBytes: 999, ObservedAt: now.Add(time.Hour)}, RateMicros: 1000000}})
	if err = s.UpdateRecords("unused", "unused", func(_ json.RawMessage) ([]store.RecordWrite, error) { return records, nil }); err != nil {
		t.Fatal(err)
	}
	recipients, users, err := s.NotificationInputs(now)
	if err != nil {
		t.Fatal(err)
	}
	if len(recipients) != 3 || len(users) != 2 {
		t.Fatalf("unexpected inputs: %+v %+v", recipients, users)
	}
	for _, user := range users {
		policy, e := s.EffectivePolicy(user.UserID, now)
		if e != nil {
			t.Fatal(e)
		}
		window, e := policy.Entitlement.Cycle.Window(now)
		if e != nil {
			t.Fatal(e)
		}
		start, e := s.LastReset(user.UserID, window.Start, now)
		if e != nil {
			t.Fatal(e)
		}
		usage, e := s.Usage(user.UserID, start, now.Add(time.Nanosecond))
		if e != nil {
			t.Fatal(e)
		}
		if user.UsedBytes != usage.WeightedBytes || user.QuotaBytes != policy.QuotaBytes || user.CycleID != start.UTC().Format(time.RFC3339Nano) {
			t.Fatalf("snapshot differs for %s: %+v usage %+v", user.UserID, user, usage)
		}
	}
}

func TestNotificationInputsPreservePolicyOverridesResetBoundaryAndDisabledAccounts(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{10}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	reset := now.Add(-30 * time.Minute)
	expiry := now.Add(time.Hour)
	override := int64(777)
	for _, id := range []string{"alice", "bob", "charlie"} {
		if err = s.PutUser(domain.User{ID: id, Name: id, Enabled: true, QuotaBytes: 1000}); err != nil {
			t.Fatal(err)
		}
	}
	writes := []store.RecordWrite{
		{Kind: "services", ID: "group-plan", Value: service.Plan{ID: "group-plan", Name: "Group", QuotaBytes: 333, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}},
		{Kind: "services", ID: "individual-plan", Value: service.Plan{ID: "individual-plan", Name: "Individual", QuotaBytes: 444, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}},
		{Kind: "user-groups", ID: "group", Value: service.Group{ID: "group", Name: "Group", ServiceID: "group-plan", Priority: 1, MemberIDs: []string{"alice", "bob"}}},
		{Kind: "entitlements", ID: "alice", Value: service.Entitlement{UserID: "alice", ExpiresAt: &expiry, Cycle: service.CyclePolicy{Mode: "fixed-days", Days: 7, Anchor: now.Add(-48 * time.Hour), Timezone: "UTC+8"}}},
		{Kind: "entitlements", ID: "bob", Value: service.Entitlement{UserID: "bob", ServiceID: "individual-plan", QuotaOverride: &override, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}},
		{Kind: "accounts", ID: "charlie", Value: store.Account{ID: "charlie", Role: "user", Disabled: true}},
		{Kind: "resets", ID: "reset", Value: store.Reset{ID: "reset", UserID: "alice", At: reset, Reason: "Synthetic fixture"}},
		{Kind: "resets", ID: "future-reset", Value: store.Reset{ID: "future-reset", UserID: "alice", At: now.Add(time.Hour), Reason: "Future fixture"}},
	}
	for i, at := range []time.Time{reset.Add(-time.Nanosecond), reset, now, now.Add(time.Nanosecond)} {
		writes = append(writes, store.RecordWrite{Kind: "ledger", ID: fmt.Sprintf("boundary-%d", i), Value: store.MeterRecord{MeterBatch: store.MeterBatch{UserID: "alice", RawBytes: 1, ObservedAt: at}, RateMicros: 333333}})
	}
	if err = s.UpdateRecords("unused", "unused", func(json.RawMessage) ([]store.RecordWrite, error) { return writes, nil }); err != nil {
		t.Fatal(err)
	}
	recipients, users, err := s.NotificationInputs(now)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 {
		t.Fatalf("disabled account entered reminder evaluation: %+v", users)
	}
	for _, r := range recipients {
		if r.ID == "charlie" && r.Enabled {
			t.Fatal("disabled account recipient enabled")
		}
	}
	for _, u := range users {
		switch u.UserID {
		case "alice":
			if u.QuotaBytes != 333 || u.UsedBytes != 1 || u.CycleID != reset.UTC().Format(time.RFC3339Nano) || u.ExpiresAt == nil || !u.ExpiresAt.Equal(expiry) {
				t.Fatalf("group/reset boundary mismatch: %+v", u)
			}
		case "bob":
			if u.QuotaBytes != 777 {
				t.Fatalf("individual quota override lost: %+v", u)
			}
		}
	}
}
