package httpapi

import (
	"encoding/json"
	"errors"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func ObserveAttributionServicesForTest(t *testing.T, s *store.Store) {
	t.Helper()
	for _, id := range []string{"rotation-core", "rotation-transit"} {
		var d controlprotocol.Desired
		if e := s.Get("agent-desired", id, &d); e != nil {
			t.Fatal(e)
		}
		var intent serviceIntent
		if e := s.Get("agent-service-intents", id, &intent); e != nil {
			t.Fatal(e)
		}
		intent.Status = "running"
		s.Put("agent-service-intents", id, intent)
		identity := d.Identity()
		s.Put("agent-observations", id, controlprotocol.State{Desired: &identity, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}})
	}
}
func AdvanceAttributedOutputForTest(t *testing.T, s *store.Store, owner, id string) string {
	t.Helper()
	h := &server{s: s, opts: Options{AdminToken: "012345678901234567890123456789012345"}}
	in, e := h.advanceAttributedOutput(owner, id)
	if e != nil {
		t.Fatal(e)
	}
	return in.State
}
func SettleAttributedBytesForTest(t *testing.T, s *store.Store, owner, id string, bytes uint64) {
	t.Helper()
	var in attributedOutputIntent
	if e := s.TenantGet(owner, "output-attribution-intents", id, &in); e != nil {
		t.Fatal(e)
	}
	p := in.Plans[0]
	var d controlprotocol.Desired
	s.Get("agent-desired", p.InstanceID, &d)
	request := store.AdmissionRequest{EntryID: p.EntryID, SubjectID: p.Principal.SubjectID, CredentialVersion: p.Grant.CredentialVersion, ClientIP: "192.0.2.1", PresenceID: "proof-" + id}
	now := time.Now().UTC()
	result, e := s.AcquireAdmission(d.Scope, request, now)
	if e != nil || !result.Allowed {
		t.Fatalf("admission %+v %v", result, e)
	}
	request.AdmittedBytes = bytes
	request.Final = true
	if _, e = s.AcquireAdmission(d.Scope, request, now.Add(time.Millisecond)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.AcquireAdmission(d.Scope, request, now.Add(2*time.Millisecond)); e != nil {
		t.Fatal(e)
	}
	rows, e := s.List("ledger")
	if e != nil {
		t.Fatal(e)
	}
	total := int64(0)
	for _, raw := range rows {
		var record store.MeterRecord
		json.Unmarshal(raw, &record)
		if record.OutputID == id {
			total += record.RawBytes
			if record.UserID != owner || record.OutputRevision != in.Revision {
				t.Fatal("wrong attribution")
			}
		}
	}
	if total != int64(bytes) {
		t.Fatalf("want %d, got %d", bytes, total)
	}
}

func AdvancePastAttributionCooldownForTest(t *testing.T, s *store.Store, owner, id string) {
	t.Helper()
	h := &server{s: s, opts: Options{AdminToken: "012345678901234567890123456789012345"}}
	if _, err := h.advanceAttributedOutput(owner, id); !errors.Is(err, ErrPrincipalMigrationRateLimited) {
		t.Fatalf("second rapid creation must queue, got %v", err)
	}
	var rate principalMigrationRateRecord
	if err := s.Get(principalMigrationRateKind, "deployment-rotation-path", &rate); err != nil {
		t.Fatal(err)
	}
	for i := range rate.Events {
		rate.Events[i].At = time.Now().UTC().Add(-61 * time.Second)
	}
	if err := s.Put(principalMigrationRateKind, "deployment-rotation-path", rate); err != nil {
		t.Fatal(err)
	}
}

func RecordAttributionCleanupRetryForTest(t *testing.T, s *store.Store, owner, id string) {
	t.Helper()
	h := &server{s: s}
	h.recordAttributedOutputRetry(owner, id, errors.New("synthetic transient observation failure"))
	var in attributedOutputIntent
	if err := s.TenantGet(owner, "output-attribution-intents", id, &in); err != nil {
		t.Fatal(err)
	}
	if in.State != "cancelling" || in.FailureCode != "cleanup_requires_runtime_evidence" {
		t.Fatal("retry changed resumable cancellation state")
	}
}
