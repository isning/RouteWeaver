package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func attributedTestOutput(id, token string) map[string]any {
	hash := sha256.Sum256([]byte(token))
	return map[string]any{"id": id, "status": "published", "revision": "publication-revision", "token": token, "tokenDigest": hex.EncodeToString(hash[:]), "artifacts": []string{"synthetic"}}
}
func TestAttributedPublicationAndCancellationAreAtomic(t *testing.T) {
	s, p, now := attributionFixture(t)
	b := attributionBinding("output-one")
	provisionAttribution(t, s, p, b)
	intent := map[string]any{"revision": b.OutputRevision, "state": "provisioning", "migration": map[string]any{"id": "migration1", "instances": []any{"entry", "exit"}}, "opaque": "retain-me", "migrationIds": map[string]string{"deployment": "migration1"}}
	if e := s.TenantPut(b.UserID, "output-attribution-intents", b.OutputID, intent); e != nil {
		t.Fatal(e)
	}
	putAttributionMigrationLock(t, s, b.UserID, b.OutputID, b.OutputRevision, "deployment", "migration1", "applied")
	queue := OutputAttributionQueueRecord(b.UserID, b.OutputID)
	if e := s.Put(queue.Kind, queue.ID, queue.Value); e != nil {
		t.Fatal(e)
	}
	output := attributedTestOutput(b.OutputID, "synthetic-secret")
	digest := output["tokenDigest"].(string)
	proof := map[string]any{"revision": "applied-one"}
	if e := s.Put("test-applied", "path", proof); e != nil {
		t.Fatal(e)
	}
	badProof := []RecordCompare{{Kind: "test-applied", ID: "path", Expected: map[string]any{"revision": "stale"}}}
	if e := s.CompareInputsAndPublishAttributedOutput(attributionPublicationFence(t, s), b.UserID, b.OutputID, b.OutputRevision, output, digest, badProof, nil); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale publish: %v", e)
	}
	var raw map[string]any
	if e := s.TenantGet(b.UserID, "outputs", b.OutputID, &raw); e != ErrNotFound {
		t.Fatal("partial output")
	}
	if _, e := s.LookupToken("feeds", digest); e != ErrNotFound {
		t.Fatal("partial token")
	}
	if e := s.TenantGet(b.UserID, "output-attribution-intents", b.OutputID, &raw); e != nil || raw["state"] != "provisioning" {
		t.Fatal("partial state")
	}
	var queueItem OutputAttributionQueueItem
	if e := s.Get(queue.Kind, queue.ID, &queueItem); e != nil {
		t.Fatal("failed publication lost recovery pointer")
	}
	goodProof := []RecordCompare{{Kind: "test-applied", ID: "path", Expected: proof}}
	if e := s.CompareInputsAndPublishAttributedOutput(attributionPublicationFence(t, s), b.UserID, b.OutputID, b.OutputRevision, output, digest, goodProof, nil); e != nil {
		t.Fatal(e)
	}
	if got, e := s.LookupToken("feeds", digest); e != nil || got != b.UserID+"/"+b.OutputID {
		t.Fatalf("token %s %v", got, e)
	}
	if e := s.TenantGet(b.UserID, "output-attribution-intents", b.OutputID, &raw); e != nil || raw["state"] != "published" || raw["opaque"] != "retain-me" || raw["migration"].(map[string]any)["id"] != "migration1" {
		t.Fatalf("metadata lost %+v %v", raw, e)
	}
	if e := s.Get(queue.Kind, queue.ID, &queueItem); e != ErrNotFound {
		t.Fatal("published output remained in provisioning queue")
	}
	tx, e := s.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if e = s.outputAttributionEligibleTx(tx, b, attributionGrant(b)); e != nil {
		t.Fatal(e)
	}
	var budget admissionBudget
	if _, reason, e := s.grantAdmissionBudget(tx, b, "issued", &budget, now, now.Add(20*time.Second)); e != nil || reason != "" {
		t.Fatalf("issue %s %v", reason, e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	// A stale deletion cannot cancel a current feed or destroy its token.
	stale := attributedTestOutput(b.OutputID, "different")
	if e = s.CompareInputsAndCancelAttributedOutput(b.UserID, b.OutputID, b.OutputRevision, stale, nil, nil); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale delete %v", e)
	}
	if _, e = s.LookupToken("feeds", digest); e != nil {
		t.Fatal("stale delete revoked token")
	}
	// An unrelated token remains untouched.
	if e = s.SwapToken("feeds", "", "foreign-token", "other/other-output"); e != nil {
		t.Fatal(e)
	}
	if e = s.CompareInputsAndCancelAttributedOutput(b.UserID, b.OutputID, b.OutputRevision, output, nil, nil); e != nil {
		t.Fatal(e)
	}
	if e = s.Get(queue.Kind, queue.ID, &queueItem); e != nil || queueItem.Owner != b.UserID || queueItem.OutputID != b.OutputID {
		t.Fatal("cancellation lost recovery pointer")
	}
	if _, e = s.LookupToken("feeds", digest); e != ErrNotFound {
		t.Fatal("deleted token still live")
	}
	if _, e = s.LookupToken("feeds", "foreign-token"); e != nil {
		t.Fatal("foreign token removed")
	}
	if e = s.TenantGet(b.UserID, "outputs", b.OutputID, &raw); e != ErrNotFound {
		t.Fatal("output remains")
	}
	if e = s.TenantGet(b.UserID, "output-attribution-intents", b.OutputID, &raw); e != nil || raw["state"] != "cancelling" || raw["opaque"] != "retain-me" {
		t.Fatal("cancellation metadata")
	}
	tx, e = s.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if e = s.outputAttributionEligibleTx(tx, b, attributionGrant(b)); e == nil {
		t.Fatal("new admission after cancel")
	}
	if e = s.settleAdmissionBudget(tx, &budget, AdmissionRequest{AdmittedBytes: 17, Final: true}, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	ledger, e := s.List("ledger")
	if e != nil || len(ledger) != 1 {
		t.Fatalf("settlement %v", e)
	}
	var r MeterRecord
	if e = json.Unmarshal(ledger[0], &r); e != nil || r.OutputID != b.OutputID || r.RawBytes != 17 {
		t.Fatalf("lost final %v %+v", e, r)
	}
	queueRows, e := s.List("output-attribution-queue")
	if e != nil || len(queueRows) != 1 {
		t.Fatalf("wrong recovery queue %v", e)
	}
	// Idempotent coordinator retry after deletion, still with no output expected.
	if e = s.CompareInputsAndCancelAttributedOutput(b.UserID, b.OutputID, b.OutputRevision, nil, nil, nil); e != nil {
		t.Fatal(e)
	}
}

func TestAttributedPublicationRejectsTokenCollisionAndCancellationBeforePublish(t *testing.T) {
	s, _, _ := attributionFixture(t)
	if e := s.TenantPut("owner", "output-attribution-intents", "one", map[string]any{"revision": "rev", "state": "provisioning", "extra": true}); e != nil {
		t.Fatal(e)
	}
	queue := OutputAttributionQueueRecord("owner", "one")
	if e := s.Put(queue.Kind, queue.ID, queue.Value); e != nil {
		t.Fatal(e)
	}
	out := attributedTestOutput("one", "token")
	digest := out["tokenDigest"].(string)
	if e := s.SwapToken("feeds", "", digest, "foreign/output"); e != nil {
		t.Fatal(e)
	}
	if e := s.CompareInputsAndPublishAttributedOutput(attributionPublicationFence(t, s), "owner", "one", "rev", out, digest, nil, nil); e == nil {
		t.Fatal("token collision")
	}
	var item OutputAttributionQueueItem
	if e := s.Get(queue.Kind, queue.ID, &item); e != nil {
		t.Fatal("token collision lost recovery pointer")
	}
	var intent map[string]any
	if e := s.TenantGet("owner", "output-attribution-intents", "one", &intent); e != nil || intent["state"] != "provisioning" {
		t.Fatal("collision partially published")
	}
	if e := s.CompareInputsAndCancelAttributedOutput("owner", "one", "rev", nil, nil, nil); e != nil {
		t.Fatal(e)
	}
	if e := s.CompareInputsAndPublishAttributedOutput(attributionPublicationFence(t, s), "owner", "one", "rev", out, digest, nil, nil); e == nil {
		t.Fatal("cancelled intent published")
	}
	if got, e := s.LookupToken("feeds", digest); e != nil || got != "foreign/output" {
		t.Fatal("foreign token changed")
	}
}

func TestOutputAttributionQueuePaginationIsBoundedAndComplete(t *testing.T) {
	s, _, _ := attributionFixture(t)
	for i := 0; i < 205; i++ {
		q := OutputAttributionQueueRecord("owner", fmt.Sprintf("output-%03d", i))
		if e := s.Put(q.Kind, q.ID, q.Value); e != nil {
			t.Fatal(e)
		}
	}
	seen := map[string]bool{}
	after := ""
	for page := 0; page < 3; page++ {
		entries, e := s.ListOutputAttributionQueue(after, 100)
		if e != nil {
			t.Fatal(e)
		}
		want := 100
		if page == 2 {
			want = 5
		}
		if len(entries) != want {
			t.Fatalf("page %d len %d", page, len(entries))
		}
		for _, entry := range entries {
			if entry.Key <= after || seen[entry.Key] || entry.Owner != "owner" {
				t.Fatal("duplicate, unordered or wrong-owner pointer")
			}
			seen[entry.Key] = true
			after = entry.Key
		}
	}
	if len(seen) != 205 {
		t.Fatal("queue lost entries")
	}
	if entries, e := s.ListOutputAttributionQueue(after, 100); e != nil || len(entries) != 0 {
		t.Fatalf("tail %+v %v", entries, e)
	}
	for _, limit := range []int{0, -1, 101} {
		if _, e := s.ListOutputAttributionQueue("", limit); e == nil {
			t.Fatal("unbounded query")
		}
	}
	if _, e := s.ListOutputAttributionQueue("invalid", 100); e == nil {
		t.Fatal("invalid cursor")
	}
	// Authenticated but mismatched IDs are corruption, never a different owner's task.
	q := OutputAttributionQueueRecord("owner", "corrupt")
	if e := s.Put(q.Kind, q.ID, OutputAttributionQueueItem{Owner: "foreign", OutputID: "other"}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.ListOutputAttributionQueue("", 100); e == nil {
		// The corrupt record may be on a later page, so sweep once.
		cursor := ""
		failed := false
		for !failed {
			entries, e := s.ListOutputAttributionQueue(cursor, 100)
			if e != nil {
				failed = true
				break
			}
			if len(entries) == 0 {
				break
			}
			cursor = entries[len(entries)-1].Key
		}
		if !failed {
			t.Fatal("mismatched queue identity accepted")
		}
	}
}

func attributionPublicationFence(t *testing.T, s *Store) ServicePolicyFence {
	t.Helper()
	p, e := s.EffectivePolicy("owner", time.Now().UTC())
	if e != nil {
		t.Fatal(e)
	}
	return ServicePolicyFence{Checks: []ServicePolicyCheck{{Policy: p, RouteIDs: []string{"route"}}}, ValidUntil: time.Now().Add(time.Minute)}
}

func TestAttributedPublicationRequiresCurrentOwnerPolicyAndDeadline(t *testing.T) {
	for _, scenario := range []string{"missing-owner", "expired", "owner-changed"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, _ := attributionFixture(t)
			intent := map[string]any{"revision": "rev", "state": "provisioning", "migrationIds": map[string]string{"deployment": "migration"}}
			if e := s.TenantPut("owner", "output-attribution-intents", "output", intent); e != nil {
				t.Fatal(e)
			}
			putAttributionMigrationLock(t, s, "owner", "output", "rev", "deployment", "migration", "applied")
			q := OutputAttributionQueueRecord("owner", "output")
			if e := s.Put(q.Kind, q.ID, q.Value); e != nil {
				t.Fatal(e)
			}
			fence := attributionPublicationFence(t, s)
			switch scenario {
			case "missing-owner":
				fence.Checks = nil
			case "expired":
				fence.ValidUntil = time.Now().Add(-time.Second)
			case "owner-changed":
				if e := s.PutUser(domain.User{ID: "owner", Name: "Owner", Enabled: false}); e != nil {
					t.Fatal(e)
				}
			}
			out := attributedTestOutput("output", "synthetic-token")
			if e := s.CompareInputsAndPublishAttributedOutput(fence, "owner", "output", "rev", out, out["tokenDigest"].(string), nil, nil); e == nil {
				t.Fatal("unauthorized publication")
			}
			var item OutputAttributionQueueItem
			if e := s.Get(q.Kind, q.ID, &item); e != nil {
				t.Fatal("policy conflict dropped recovery")
			}
			if _, e := s.LookupToken("feeds", out["tokenDigest"].(string)); e != ErrNotFound {
				t.Fatal("policy conflict exposed token")
			}
			var state outputAttributionIntent
			if e := s.TenantGet("owner", "output-attribution-intents", "output", &state); e != nil || state.State != "provisioning" {
				t.Fatal("policy conflict opened admission")
			}
		})
	}
}
