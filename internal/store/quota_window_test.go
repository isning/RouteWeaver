package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func quotaWindowFixture(t *testing.T) (*Store, time.Time) {
	t.Helper()
	s, now, _ := quotaSourceFixture(t)
	var desired domain.DeploymentIdentity
	s.Get("agent-desired", "core", &desired)
	if _, e := s.GenerateRecord("agent-desired", "core", func(g uint64) (any, error) { desired.Generation = g; return desired, nil }); e != nil {
		t.Fatal(e)
	}
	var m domain.PublishedManifest
	if e := s.Get("published-manifests", "revision", &m); e != nil {
		t.Fatal(e)
	}
	m.PolicyExpiresAt = now.Add(30 * 24 * time.Hour)
	if e := s.Put("published-manifests", "revision", m); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("instance-enrollments", "core", map[string]any{"scope": domain.InstanceScope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}, "expiresAt": m.PolicyExpiresAt}); e != nil {
		t.Fatal(e)
	}
	status, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now)
	if e != nil || status.Available || status.Reason != "collecting_complete_window" || !status.Start.Equal(now) {
		t.Fatalf("begin %+v %v", status, e)
	}
	return s, now
}
func quotaCheckpoint(t *testing.T, s *Store, account string) quotaCoverageCheckpoint {
	t.Helper()
	var c quotaCoverageCheckpoint
	if e := s.Get(quotaCoverageKind, account, &c); e != nil {
		t.Fatal(e)
	}
	return c
}
func quotaBudget(account, id string, at time.Time) admissionBudget {
	return admissionBudget{LeaseID: id, AccountID: account, RouteID: "route", IssuedAt: at, ExpiresAt: at.Add(time.Minute), LastSettlement: at, Rate: service.Rate{ID: "two", Micros: 2 * service.RateScale}, Coverage: &admissionCoverage{Version: 1, StartedAt: at}}
}
func TestQuotaWindowIncrementalSealingAndIsolation(t *testing.T) {
	s, now := quotaWindowFixture(t)
	b := quotaBudget("account", "budget", now.Add(time.Second))
	if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
		t.Fatal(e)
	}
	other := quotaBudget("other", "other-budget", now.Add(time.Second))
	s.Put("admission-budgets", other.LeaseID, other)
	before := quotaCheckpoint(t, s, "account")
	b.recordCoverageReceipt(now.Add(2*time.Second), false, "agent")
	s.Put("admission-budgets", b.LeaseID, b)
	if after := quotaCheckpoint(t, s, "account"); !reflect.DeepEqual(before, after) {
		t.Fatal("zero renewal rewrote checkpoint")
	}
	b.SettledRaw = 23
	b.recordCoverageReceipt(now.Add(3*time.Second), true, "agent")
	b.Closed = true
	s.Put("admission-budgets", b.LeaseID, b)
	s.Put("admission-budgets", b.LeaseID, b)
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration))
	if e != nil || !got.Available || got.RawBytes != 23 || got.WeightedBytes != 46 || !got.End.Equal(now.Add(quotaCoverageDuration)) {
		t.Fatalf("sealed %+v %v", got, e)
	}
	c := quotaCheckpoint(t, s, "account")
	if len(c.Windows) == 0 || c.Windows[0].Issued != 1 || c.Windows[0].Closed != 1 {
		t.Fatalf("replay/foreign counted: %+v", c)
	}
	later := quotaBudget("account", "later", now.Add(quotaCoverageDuration+time.Second))
	s.Put("admission-budgets", later.LeaseID, later)
	got, e = s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration+2*time.Second))
	if e != nil || !got.Available || got.RawBytes != 23 {
		t.Fatalf("later window changed seal %+v %v", got, e)
	}
}
func TestQuotaWindowRejectsLateReviewedAndLegacyEvidence(t *testing.T) {
	for _, mode := range []string{"open", "late", "reviewed", "legacy", "clock"} {
		t.Run(mode, func(t *testing.T) {
			s, now := quotaWindowFixture(t)
			b := quotaBudget("account", "budget", now.Add(time.Second))
			s.Put("admission-budgets", b.LeaseID, b)
			switch mode {
			case "late":
				b.recordCoverageReceipt(now.Add(quotaCoverageDuration+time.Second), true, "agent")
				b.Closed = true
			case "reviewed":
				b.recordCoverageReceipt(now.Add(time.Minute), true, "reviewed")
				b.Closed = true
			case "legacy":
				b.Coverage = nil
			case "clock":
				b.Coverage.ClockUncertain = true
			}
			s.Put("admission-budgets", b.LeaseID, b)
			got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration))
			if e != nil || got.Available {
				t.Fatalf("unsafe %s %+v %v", mode, got, e)
			}
		})
	}
}
func TestQuotaWindowABAAndUnrelatedSourceChanges(t *testing.T) {
	s, now := quotaWindowFixture(t)
	before := quotaCheckpoint(t, s, "account")
	foreign := MeterBinding{UserID: "other", ID: "foreign", RouteID: "other-route"}
	s.Put("meter-bindings", "foreign", foreign)
	s.Remove("meter-bindings", "foreign")
	if after := quotaCheckpoint(t, s, "account"); !reflect.DeepEqual(before, after) {
		t.Fatal("foreign source reset owner")
	}
	own := MeterBinding{UserID: "account", ID: "transient", RouteID: "route"}
	s.Put("meter-bindings", "transient", own)
	s.Remove("meter-bindings", "transient")
	invalid := quotaCheckpoint(t, s, "account")
	if !invalid.Invalid || invalid.Generation <= before.Generation {
		t.Fatal("ABA was missed")
	}
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(time.Minute))
	if e != nil || !got.Start.Equal(now.Add(time.Minute)) || got.Available {
		t.Fatalf("history backfilled %+v %v", got, e)
	}
}
func TestQuotaWindowSemanticRefreshAndDependencyMutation(t *testing.T) {
	s, now := quotaWindowFixture(t)
	before := quotaCheckpoint(t, s, "account")
	var raw map[string]any
	s.Get("agent-observations", "core", &raw)
	raw["reportSequence"] = "2"
	raw["observed"].(map[string]any)["observedAt"] = now.Add(time.Minute)
	s.Put("agent-observations", "core", raw)
	var m domain.PublishedManifest
	s.Get("published-manifests", "revision", &m)
	m.PolicyExpiresAt = m.PolicyExpiresAt.Add(time.Hour)
	s.Put("published-manifests", "revision", m)
	if after := quotaCheckpoint(t, s, "account"); !reflect.DeepEqual(before, after) {
		t.Fatal("heartbeat/lease refresh reset window")
	}
	var endpoint json.RawMessage
	s.Get("managed-endpoints", "entry", &endpoint)
	s.Remove("managed-endpoints", "entry")
	s.Put("managed-endpoints", "entry", endpoint)
	if !quotaCheckpoint(t, s, "account").Invalid {
		t.Fatal("dependency ABA missed")
	}
}
func TestQuotaWindowRollbackAndRestoreDiscardCheckpoint(t *testing.T) {
	s, now := quotaWindowFixture(t)
	before := quotaCheckpoint(t, s, "account")
	err := s.CompareAndPutRecords(nil, []RecordWrite{{Kind: "meter-bindings", ID: "transient", Value: MeterBinding{UserID: "account"}}, {Kind: "bad", ID: "bad", Value: make(chan int)}})
	if err == nil {
		t.Fatal("expected rollback")
	}
	if after := quotaCheckpoint(t, s, "account"); !reflect.DeepEqual(before, after) {
		t.Fatal("rollback retained source change")
	}
	snap, e := s.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "restored")
	key := bytes.Repeat([]byte{7}, 32)
	if e = RestoreFresh(context.Background(), path, key, snap); e != nil {
		t.Fatal(e)
	}
	restored, e := Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	var c quotaCoverageCheckpoint
	if e = restored.Get(quotaCoverageKind, "account", &c); e != nil {
		t.Fatal(e)
	}
	var epoch string
	if e = restored.db.QueryRow(`SELECT epoch FROM quota_coverage_state WHERE id=1`).Scan(&epoch); e != nil {
		t.Fatal(e)
	}
	if c.Epoch == epoch {
		t.Fatal("restore reused old coverage epoch")
	}
	got, e := restored.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(time.Hour))
	if e != nil || got.Available || !got.Start.Equal(now.Add(time.Hour)) {
		t.Fatalf("restore backfilled %+v %v", got, e)
	}
}

func TestQuotaWindowRealAdmissionMatchesLedgerAndSurvivesReopen(t *testing.T) {
	s, now := quotaWindowFixture(t)
	s.PutUser(domain.User{ID: "account", Name: "Synthetic", Enabled: true})
	s.Put("services", "plan", service.Plan{ID: "plan", Name: "Plan", QuotaBytes: 1000, RouteIDs: []string{"route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}})
	s.Put("entitlements", "account", service.Entitlement{UserID: "account", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}})
	if _, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now); e != nil {
		t.Fatal(e)
	}
	scope := AdmissionScope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	in := AdmissionRequest{EntryID: "entry", SubjectID: "subject", CredentialVersion: "v1", ClientIP: "192.0.2.1", PresenceID: "real"}
	first, e := s.AcquireAdmission(scope, in, now.Add(time.Second))
	if e != nil || !first.Allowed {
		t.Fatalf("acquire %+v %v", first, e)
	}
	in.AdmittedBytes = 75
	in.Final = true
	final, e := s.AcquireAdmission(scope, in, now.Add(2*time.Second))
	if e != nil || final.Reason != "presence-closed" {
		t.Fatalf("final %+v %v", final, e)
	}
	usage, e := s.Usage("account", time.Time{}, time.Time{})
	if e != nil {
		t.Fatal(e)
	}
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration))
	if e != nil || !got.Available || got.RawBytes != uint64(usage.RawBytes) || got.WeightedBytes != uint64(usage.WeightedBytes) || got.RawBytes != 75 {
		t.Fatalf("ledger mismatch %+v %+v %v", got, usage, e)
	}
	// A normal second process handle must preserve the shared durable epoch.
	var databases string
	if e = s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&databases); e != nil {
		t.Fatal(e)
	}
	second, e := Open(databases, bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	again, e := second.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration))
	if e != nil || !reflect.DeepEqual(again, got) {
		t.Fatalf("normal reopen lost coverage %+v %v", again, e)
	}
}

func TestQuotaWindowStreamingRestoreDoesNotReuseObservation(t *testing.T) {
	s, now := quotaWindowFixture(t)
	target, e := Open(filepath.Join(t.TempDir(), "stream-target"), bytes.Repeat([]byte{8}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	limits := BackupLimits{MaxBytes: 8 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}
	e = target.ImportBackup(context.Background(), limits, func(emit func(BackupFrame) error) error { return s.ExportBackup(context.Background(), limits, emit) })
	if e != nil {
		t.Fatal(e)
	}
	got, e := target.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(time.Hour))
	if e != nil || got.Available || !got.Start.Equal(now.Add(time.Hour)) {
		t.Fatalf("stream reused observation %+v %v", got, e)
	}
}
func TestQuotaCorruptOptionalCheckpointDoesNotBlockBudgetPersistence(t *testing.T) {
	s, now := quotaWindowFixture(t)
	if _, e := s.db.Exec(`UPDATE records SET data=x'010203' WHERE kind=? AND id='account'`, quotaCoverageKind); e != nil {
		t.Fatal(e)
	}
	b := quotaBudget("account", "budget", now.Add(time.Second))
	if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
		t.Fatalf("corrupt optional evidence blocked budget: %v", e)
	}
	b.SettledRaw = 5
	b.Closed = true
	b.recordCoverageReceipt(now.Add(time.Minute), true, "agent")
	if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
		t.Fatal(e)
	}
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(quotaCoverageDuration))
	if e != nil || got.Available || !got.Start.Equal(now.Add(quotaCoverageDuration)) {
		t.Fatalf("corruption was salvaged as complete %+v %v", got, e)
	}
}

func TestQuotaRollingDailyWindowsAndConfirmedIdle(t *testing.T) {
	s, now := quotaWindowFixture(t)
	for day := 0; day < 11; day++ {
		at := now.Add(time.Duration(day)*24*time.Hour + time.Second)
		b := quotaBudget("account", fmt.Sprintf("day-%d", day), at)
		if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
			t.Fatal(e)
		}
		b.SettledRaw = 10
		b.recordCoverageReceipt(at.Add(time.Second), true, "agent")
		b.Closed = true
		if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
			t.Fatal(e)
		}
		if c := quotaCheckpoint(t, s, "account"); c.Invalid {
			t.Fatalf("invalid after day %d %+v", day, c)
		}
		if day >= 7 {
			got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", at.Add(2*time.Second))
			if e != nil || !got.Available || got.RawBytes != 70 {
				t.Fatalf("day %d: %+v %v", day, got, e)
			}
		}
		if c := quotaCheckpoint(t, s, "account"); len(c.Windows) > 9 {
			t.Fatal("unbounded windows")
		}
	}
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(18*24*time.Hour))
	if e != nil || !got.Available || got.RawBytes != 0 || !got.End.Equal(now.Add(18*24*time.Hour)) {
		t.Fatalf("confirmed idle %+v %v", got, e)
	}
}

func TestQuotaLimitChangePreservesEvidence(t *testing.T) {
	s, now := quotaWindowFixture(t)
	// Existing identity updates can change quota without falsifying measured usage.
	u := domain.User{ID: "account", QuotaBytes: 1000, Enabled: true}
	if e := s.Put("users", u.ID, u); e != nil {
		t.Fatal(e)
	}
	s.ObserveQuotaCoverageContext(context.Background(), u.ID, now)
	before := quotaCheckpoint(t, s, u.ID)
	u.QuotaBytes = 2000
	if e := s.Put("users", u.ID, u); e != nil {
		t.Fatal(e)
	}
	after := quotaCheckpoint(t, s, u.ID)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("quota-only update reset observation")
	}
}

func TestQuotaRollingCrossCutoffNeverAllocatesPartialBudget(t *testing.T) {
	s, now := quotaWindowFixture(t)
	b := quotaBudget("account", "cross", now.Add(6*24*time.Hour))
	if e := s.Put("admission-budgets", b.LeaseID, b); e != nil {
		t.Fatal(e)
	}
	got, e := s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(7*24*time.Hour))
	if e != nil || got.Available {
		t.Fatalf("open budget sealed %+v %v", got, e)
	}
	b.SettledRaw = 100
	b.recordCoverageReceipt(now.Add(8*24*time.Hour), true, "agent")
	b.Closed = true
	if e = s.Put("admission-budgets", b.LeaseID, b); e != nil {
		t.Fatal(e)
	}
	got, e = s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(8*24*time.Hour))
	if e != nil || got.Available {
		t.Fatalf("late final assigned to old window %+v %v", got, e)
	}
	c := quotaCheckpoint(t, s, "account")
	if c.Invalid {
		t.Fatal("late final discarded later complete observation")
	}
	got, e = s.ObserveQuotaCoverageContext(context.Background(), "account", now.Add(13*24*time.Hour))
	if e != nil || !got.Available || got.RawBytes != 100 {
		t.Fatalf("later full interval %+v %v", got, e)
	}
}
