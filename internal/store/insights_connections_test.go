package store

import (
	"context"
	"testing"
	"time"
)

func TestInsightsConnectionDetailsUseOwnedLiveEvidence(t *testing.T) {
	s, now := rebuildFixture(t)
	known := now.Add(-time.Second)
	cases := []admissionLease{
		{ID: "a", Binding: EntryAdmissionBinding{UserID: "u", OutputID: "personal"}, ClientIP: "192.0.2.1", ExpiresAt: now.Add(time.Second), ConfirmedAt: known},
		{ID: "b", Binding: EntryAdmissionBinding{UserID: "u", OutputID: "personal"}, ClientIP: "192.0.2.1", ExpiresAt: now.Add(time.Second), ConfirmedAt: now},
		{ID: "legacy", Binding: EntryAdmissionBinding{UserID: "u"}, ClientIP: "192.0.2.1", ExpiresAt: now.Add(time.Second)},
		{ID: "foreign", Binding: EntryAdmissionBinding{UserID: "other", OutputID: "private"}, ClientIP: "192.0.2.1", ExpiresAt: now.Add(time.Second), ConfirmedAt: now},
		{ID: "expired", Binding: EntryAdmissionBinding{UserID: "u", OutputID: "expired"}, ClientIP: "192.0.2.2", ExpiresAt: now, ConfirmedAt: known},
	}
	for _, lease := range cases {
		if err := s.Put("entry-admission-leases", lease.ID, lease); err != nil {
			t.Fatal(err)
		}
	}
	check := func() {
		t.Helper()
		v, err := s.UsageInsightsContext(context.Background(), "u", time.Time{}, now)
		if err != nil {
			t.Fatal(err)
		}
		a := v.Admission
		if !a.Available || a.ActiveStreams != 3 || len(a.OnlineIPs) != 1 || len(a.Connections) != 2 {
			t.Fatalf("invalid owned aggregation: %+v", a)
		}
		shared, independent := a.Connections[0], a.Connections[1]
		if shared.IP != "192.0.2.1" || shared.OutputID != "" || shared.ActiveStreams != 1 || shared.LastConfirmedAt != nil {
			t.Fatalf("legacy must stay unknown: %+v", shared)
		}
		if independent.OutputID != "personal" || independent.ActiveStreams != 2 || independent.LastConfirmedAt == nil || !independent.LastConfirmedAt.Equal(now) {
			t.Fatalf("independent evidence: %+v", independent)
		}
	}
	check() // cold canonical read
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.admissionLiveWindowTx(tx, leaseLive, "u", now); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	check() // authenticated hot projection must have identical semantics
}
