package httpapi

import (
	"bytes"
	"context"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestSubscriptionRefreshScheduling(t *testing.T) {
	now := time.Now().UTC()
	recent := now.Add(-30 * time.Minute)
	due := now.Add(-time.Hour)
	for _, tc := range []struct {
		name   string
		source Source
		want   bool
	}{
		{"new URL", Source{Kind: "url", Enabled: true}, true},
		{"due manual", Source{Kind: "url", Enabled: true, ApplyMode: "manual", CheckedAt: &due}, true},
		{"recent", Source{Kind: "url", Enabled: true, CheckedAt: &recent}, false},
		{"paused", Source{Kind: "url"}, false},
		{"text", Source{Kind: "text", Enabled: true}, false},
		{"pending review", Source{Kind: "url", Enabled: true, Candidate: &SourceCandidate{}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if subscriptionDue(tc.source, now) != tc.want {
				t.Fatal("unexpected eligibility")
			}
		})
	}
}

func TestScheduledSourceFailureIsPersistedAndBackedOff(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "state.db"), bytes.Repeat([]byte{17}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("accounts", "owner", store.Account{ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	source := Source{ID: "source", OwnerID: "owner", Kind: "url", Enabled: true, URL: "http://127.0.0.1/private", ApplyMode: "manual"}
	if err = s.TenantPut("owner", "sources", source.ID, source); err != nil {
		t.Fatal(err)
	}
	h := &server{s: s}
	h.refreshDueSubscriptions(context.Background(), time.Now().UTC())
	var after Source
	if err = s.TenantGet("owner", "sources", source.ID, &after); err != nil {
		t.Fatal(err)
	}
	if after.RefreshStatus != "failed" || after.CheckedAt == nil || after.LastErrorCode == "" {
		t.Fatal("missing durable failure")
	}
	revision := after.Revision
	h.refreshDueSubscriptions(context.Background(), time.Now().UTC())
	if err = s.TenantGet("owner", "sources", source.ID, &after); err != nil {
		t.Fatal(err)
	}
	if after.Revision != revision {
		t.Fatal("retried before hourly interval")
	}
}

func TestSubscriptionRefreshUsesSavedInterval(t *testing.T) {
	now := time.Now().UTC()
	checked := now.Add(-20 * time.Minute)
	source := Source{Kind: "url", Enabled: true, CheckedAt: &checked, RefreshIntervalSeconds: 900}
	if !subscriptionDue(source, now) {
		t.Fatal("15-minute source not due")
	}
	source.RefreshIntervalSeconds = 1800
	if subscriptionDue(source, now) {
		t.Fatal("30-minute source refreshed early")
	}
	for _, invalid := range []int{-1, 1, 899, 901, 86401} {
		if validSubscriptionInterval(invalid) {
			t.Fatalf("accepted unsupported interval %d", invalid)
		}
	}
	if subscriptionInterval(0) != time.Hour {
		t.Fatal("legacy interval changed")
	}
}
