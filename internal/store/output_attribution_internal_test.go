package store

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"testing"
	"time"
)

func attributionFixture(t *testing.T) (*Store, service.EffectivePolicy, time.Time) {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{45}, 32))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Now().UTC()
	for _, r := range []RecordWrite{
		{"users", "owner", domain.User{ID: "owner", Name: "Owner", Enabled: true}},
		{"services", "plan", service.Plan{ID: "plan", Name: "Plan", RouteIDs: []string{"route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}},
		{"entitlements", "owner", service.Entitlement{UserID: "owner", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}},
		{"core-instances", "instance", domain.CoreInstance{ID: "instance", HostID: "host", AdapterID: "routeweaver/managed-xray"}},
		{"managed-endpoints", "entry", domain.ManagedEndpoint{ID: "entry", InstanceID: "instance"}},
	} {
		if e = s.Put(r.Kind, r.ID, r.Value); e != nil {
			t.Fatal(e)
		}
	}
	policy, e := s.EffectivePolicy("owner", now)
	if e != nil {
		t.Fatal(e)
	}
	return s, policy, now
}
func attributionBinding(id string) EntryAdmissionBinding {
	return EntryAdmissionBinding{ID: id, InstanceID: "instance", EntryID: "entry", SubjectID: id, UserID: "owner", RouteID: "route", GrantID: id, CredentialVersion: "v1", OutputID: id, OutputRevision: "revision1"}
}
func attributionGrant(b EntryAdmissionBinding) admissionGrant {
	return admissionGrant{ID: b.GrantID, UserID: b.UserID, RouteID: b.RouteID, CredentialVersion: b.CredentialVersion, PublishedRouteID: b.RouteID, SubjectID: b.SubjectID, DeploymentID: "deployment", OutputID: b.OutputID, OutputRevision: b.OutputRevision}
}
func provisionAttribution(t *testing.T, s *Store, p service.EffectivePolicy, b EntryAdmissionBinding) {
	t.Helper()
	if e := s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, outputAttributionIntent{b.OutputRevision, "reserved"}); e != nil {
		t.Fatal(e)
	}
	writes := []RecordWrite{{TenantKind(b.UserID, "platform-entries"), b.GrantID, attributionGrant(b)}}
	if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{b}, nil, writes); e != nil {
		t.Fatal(e)
	}
}
func TestOutputAttributionClaimRequiresReservationAndRollsBack(t *testing.T) {
	s, p, _ := attributionFixture(t)
	b := attributionBinding("output-one")
	writes := []RecordWrite{{TenantKind(b.UserID, "platform-entries"), b.GrantID, attributionGrant(b)}}
	if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{b}, nil, writes); e == nil {
		t.Fatal("missing reservation allowed")
	}
	var g admissionGrant
	if e := s.TenantGet(b.UserID, "platform-entries", b.GrantID, &g); e != ErrNotFound {
		t.Fatal("partial grant")
	}
	provisionAttribution(t, s, p, b)
	if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{b}, nil, writes); e == nil {
		t.Fatal("binding reused")
	}
	if e := s.SetEntryAdmissionBinding(b); e == nil {
		t.Fatal("legacy binding setter accepted output scope")
	}
	other := attributionBinding("output-two")
	other.UserID = "foreign"
	if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{other}, nil, nil); e == nil {
		t.Fatal("foreign owner allowed")
	}
	// A conflict on the last binding cannot leave the first claim or grant.
	fresh := attributionBinding("output-two")
	fresh.OutputID = b.OutputID
	fresh.GrantID = "fresh-grant"
	writes = []RecordWrite{{TenantKind(fresh.UserID, "platform-entries"), fresh.GrantID, attributionGrant(fresh)}}
	if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{fresh, b}, nil, writes); e == nil {
		t.Fatal("reuse allowed")
	}
	var claim OutputAttributionClaim
	if e := s.Get("output-attribution-claims", admissionBindingKey(fresh.InstanceID, fresh.EntryID, fresh.SubjectID, fresh.CredentialVersion), &claim); e != ErrNotFound {
		t.Fatal("partial claim")
	}
	if e := s.TenantGet(fresh.UserID, "platform-entries", fresh.GrantID, &g); e != ErrNotFound {
		t.Fatal("partial grant")
	}
}
func TestOutputAttributionBudgetSnapshotSeparatesOutputsAndPreservesLegacy(t *testing.T) {
	s, p, now := attributionFixture(t)
	bindings := []EntryAdmissionBinding{attributionBinding("output-one"), attributionBinding("output-two")}
	for _, b := range bindings {
		provisionAttribution(t, s, p, b)
		tx, e := s.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		if e = s.outputAttributionEligibleTx(tx, b, attributionGrant(b)); e == nil {
			t.Fatal("unpublished intent admitted")
		}
		tx.Rollback()
		if e = s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, outputAttributionIntent{b.OutputRevision, "published"}); e != nil {
			t.Fatal(e)
		}
	}
	for i, b := range bindings {
		tx, e := s.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		if e = s.outputAttributionEligibleTx(tx, b, attributionGrant(b)); e != nil {
			t.Fatal(e)
		}
		var budget admissionBudget
		if _, reason, e := s.grantAdmissionBudget(tx, b, "lease-"+b.ID, &budget, now, now.Add(20*time.Second)); e != nil || reason != "" {
			t.Fatalf("%s %v", reason, e)
		}
		if e = tx.Commit(); e != nil {
			t.Fatal(e)
		}
		// Failure/revocation after issuance cannot erase already measured traffic.
		if e = s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, outputAttributionIntent{b.OutputRevision, "failed"}); e != nil {
			t.Fatal(e)
		}
		tx, e = s.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		in := AdmissionRequest{AdmittedBytes: uint64((i + 1) * 20), Final: true}
		if e = s.settleAdmissionBudget(tx, &budget, in, now.Add(time.Second)); e != nil {
			t.Fatal(e)
		}
		if e = s.settleAdmissionBudget(tx, &budget, in, now.Add(2*time.Second)); e != nil {
			t.Fatal(e)
		}
		if e = tx.Commit(); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.RecordMeter(MeterBatch{UserID: "owner", RouteID: "route", MeterID: "legacy", Epoch: "epoch", Sequence: 1, RawBytes: 7, ObservedAt: now}); e != nil {
		t.Fatal(e)
	}
	raw, e := s.List("ledger")
	if e != nil {
		t.Fatal(e)
	}
	totals := map[string]int64{}
	for _, v := range raw {
		var r MeterRecord
		if e = json.Unmarshal(v, &r); e != nil {
			t.Fatal(e)
		}
		totals[r.OutputID] += r.RawBytes
	}
	if len(raw) != 3 || totals["output-one"] != 20 || totals["output-two"] != 40 || totals[""] != 7 {
		t.Fatalf("wrong attribution %v", totals)
	}
	usage, e := s.Usage("owner", time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 67 {
		t.Fatalf("account ledger changed %+v %v", usage, e)
	}
	// Generic agent input has no output fields: JSON cannot attach an attribution.
	var batch MeterBatch
	if e = json.Unmarshal([]byte(`{"userId":"owner","routeId":"route","meterId":"forged","epoch":"e","sequence":1,"rawBytes":1,"outputId":"output-one","outputRevision":"revision1"}`), &batch); e != nil {
		t.Fatal(e)
	}
	batch.ObservedAt = now
	if e = s.RecordMeter(batch); e != nil {
		t.Fatal(e)
	}
	raw, e = s.List("ledger")
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range raw {
		var r MeterRecord
		json.Unmarshal(v, &r)
		if r.MeterID == "forged" && r.OutputID != "" {
			t.Fatal("generic counter forged attribution")
		}
	}
	snapshot, e := s.ExportSnapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	restored, e := Open(filepath.Join(t.TempDir(), "restored"), bytes.Repeat([]byte{47}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	if e = restored.ImportSnapshot(context.Background(), snapshot); e != nil {
		t.Fatal(e)
	}
	restoredRaw, e := restored.List("ledger")
	if e != nil || len(restoredRaw) != 4 {
		t.Fatalf("restore %v", e)
	}
	var claim OutputAttributionClaim
	b := bindings[0]
	if e = restored.Get("output-attribution-claims", admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion), &claim); e != nil || claim.Binding != b {
		t.Fatalf("claim not restored %v", e)
	}
}

func TestOutputAttributionRejectsInvalidOwnershipAndTerminalIntents(t *testing.T) {
	for _, scenario := range []string{"revision", "terminal", "grant-owner", "grant-output", "unsupported-runtime", "duplicate-write"} {
		t.Run(scenario, func(t *testing.T) {
			s, p, _ := attributionFixture(t)
			b := attributionBinding("output-one")
			intent := outputAttributionIntent{b.OutputRevision, "reserved"}
			g := attributionGrant(b)
			switch scenario {
			case "revision":
				intent.Revision = "other"
			case "terminal":
				intent.State = "failed"
			case "grant-owner":
				g.UserID = "foreign"
			case "grant-output":
				g.OutputID = "foreign-output"
			case "unsupported-runtime":
				if e := s.Put("core-instances", "instance", domain.CoreInstance{ID: "instance", AdapterID: "xray"}); e != nil {
					t.Fatal(e)
				}
			}
			if e := s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, intent); e != nil {
				t.Fatal(e)
			}
			writes := []RecordWrite{{TenantKind(b.UserID, "platform-entries"), b.GrantID, g}}
			if scenario == "duplicate-write" {
				writes = append(writes, writes[0])
			}
			if e := s.ComparePolicyAndPutAttributedRecords(p, b.OutputID, b.OutputRevision, []EntryAdmissionBinding{b}, nil, writes); e == nil {
				t.Fatal("invalid attribution allowed")
			}
			var claim OutputAttributionClaim
			if e := s.Get("output-attribution-claims", admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion), &claim); e != ErrNotFound {
				t.Fatal("partial claim committed")
			}
		})
	}
}

func TestOutputAttributionGenerationsAndClaimsCommitAtomically(t *testing.T) {
	s, p, _ := attributionFixture(t)
	b := attributionBinding("output-one")
	if e := s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, outputAttributionIntent{b.OutputRevision, "reserved"}); e != nil {
		t.Fatal(e)
	}
	fence := ServicePolicyFence{Checks: []ServicePolicyCheck{{Policy: p, RouteIDs: []string{"route"}}}, ValidUntil: time.Now().Add(time.Hour)}
	build := func(bad bool) func(map[string]uint64) ([]RecordWrite, error) {
		return func(gens map[string]uint64) ([]RecordWrite, error) {
			g := attributionGrant(b)
			if bad {
				g.OutputID = "other"
			}
			return []RecordWrite{{"test-desired", "entry-instance", gens["entry-instance"]}, {"test-desired", "exit-instance", gens["exit-instance"]}, {TenantKind(b.UserID, "platform-entries"), b.GrantID, g}}, nil
		}
	}
	invoke := func(f ServicePolicyFence, bad bool) (map[string]uint64, error) {
		return s.CompareAttributedServicePolicyAndGenerateRecords(f, p, b.OutputID, b.OutputRevision, "test-desired", []string{"entry-instance", "exit-instance"}, []EntryAdmissionBinding{b}, nil, nil, build(bad))
	}
	if _, e := invoke(fence, true); e == nil {
		t.Fatal("bad grant committed")
	}
	var value uint64
	if e := s.Get("test-desired", "entry-instance", &value); e != ErrNotFound {
		t.Fatal("partial desired committed")
	}
	generations, e := invoke(fence, false)
	if e != nil {
		t.Fatal(e)
	}
	if generations["entry-instance"] != 1 || generations["exit-instance"] != 1 {
		t.Fatalf("failed transaction consumed generation: %v", generations)
	}
	// A retry cannot mutate the immutable principal or advance either counter.
	if _, e = invoke(fence, false); e == nil {
		t.Fatal("duplicate provisioning committed")
	}
	var n int
	if e = s.db.QueryRow("SELECT value FROM counters WHERE kind=? AND id=?", "test-desired", "entry-instance").Scan(&n); e != nil || n != 1 {
		t.Fatalf("retry advanced generation %d %v", n, e)
	}
}

func TestOutputAttributionGenerationExpiryRollsBackAllWrites(t *testing.T) {
	s, p, _ := attributionFixture(t)
	b := attributionBinding("output-one")
	if e := s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, outputAttributionIntent{b.OutputRevision, "reserved"}); e != nil {
		t.Fatal(e)
	}
	fence := ServicePolicyFence{Checks: []ServicePolicyCheck{{Policy: p, RouteIDs: []string{"route"}}}, ValidUntil: time.Now().Add(150 * time.Millisecond)}
	_, e := s.CompareAttributedServicePolicyAndGenerateRecords(fence, p, b.OutputID, b.OutputRevision, "test-desired", []string{"entry-instance"}, []EntryAdmissionBinding{b}, nil, nil, func(g map[string]uint64) ([]RecordWrite, error) {
		time.Sleep(200 * time.Millisecond)
		return []RecordWrite{{"test-desired", "entry-instance", g["entry-instance"]}, {TenantKind(b.UserID, "platform-entries"), b.GrantID, attributionGrant(b)}}, nil
	})
	if e == nil {
		t.Fatal("expired capability committed")
	}
	var raw json.RawMessage
	for _, r := range []RecordWrite{{"test-desired", "entry-instance", nil}, {TenantKind(b.UserID, "platform-entries"), b.GrantID, nil}, {"output-attribution-claims", admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion), nil}} {
		if e = s.Get(r.Kind, r.ID, &raw); e != ErrNotFound {
			t.Fatalf("partial %s committed", r.Kind)
		}
	}
}
