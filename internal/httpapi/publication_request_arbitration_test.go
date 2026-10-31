package httpapi_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/store"
)

// This is a public HTTP + Store transaction-seam test, not a scheduler hook in
// publishServer. An original writer's captured proof is deliberately held while
// the real HTTP handler commits a terminal receipt. Restoring all other inputs
// isolates the shared receipt-absence fence from ordinary stale-draft fencing.
func TestPublicationRequestTerminalReceiptArbitratesPreparedStoreWriter(t *testing.T) {
	t.Run("rejection fences previously prepared generation writer", func(t *testing.T) {
		f := newFleetFixture(t)
		admin := operatorClient()
		url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
		opened := openServerDraft(t, admin, url)
		checked := requireServerValidation(t, admin, url, opened["revisionToken"].(string))
		input := map[string]any{"operationId": "arbitrated-rejection", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]}
		var original json.RawMessage
		if err := f.s.Get("server-deployments", f.in.DeploymentID, &original); err != nil {
			t.Fatal(err)
		}
		receiptID := "operator:arbitrated-rejection"
		proof := []store.RecordCompare{{Kind: "server-deployments", ID: f.in.DeploymentID, Expected: original}, {Kind: "publication-receipts", ID: receiptID}}
		var prior json.RawMessage
		if err := f.s.Get("publication-receipts", receiptID, &prior); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("unexpected existing receipt: %v", err)
		}
		var changed httpapi.ServerDeployment
		if err := json.Unmarshal(original, &changed); err != nil {
			t.Fatal(err)
		}
		changed.IR.TopologyRevision = "changed-after-original-review"
		if err := f.s.Put("server-deployments", changed.ID, changed); err != nil {
			t.Fatal(err)
		}
		code, rejected, raw := req(t, admin, "POST", url+"/publish", "", input)
		if code != 200 || rejected["status"] != "definitively-rejected" || rejected["code"] != "SERVER_DRAFT_CHANGED" {
			t.Fatalf("real rejection %d %s", code, raw)
		}
		// Restore the exact original proof dependency: only the receipt has changed.
		if err := f.s.Put("server-deployments", f.in.DeploymentID, original); err != nil {
			t.Fatal(err)
		}
		called := false
		_, err := f.s.CompareSetsAndGenerateRecords("agent-desired", f.in.TargetIDs, proof, nil, func(g map[string]uint64) ([]store.RecordWrite, error) {
			called = true
			writes := []store.RecordWrite{}
			for _, id := range f.in.TargetIDs {
				writes = append(writes, store.RecordWrite{Kind: "agent-desired", ID: id, Value: map[string]any{"generation": g[id]}})
			}
			writes = append(writes, store.RecordWrite{Kind: "publication-receipts", ID: receiptID, Value: map[string]any{"status": "must-not-replace-rejection"}})
			return writes, nil
		})
		if !errors.Is(err, store.ErrConflict) || called {
			t.Fatalf("prepared writer escaped terminal fence: err=%v callback=%v", err, called)
		}
		for _, kind := range []string{"agent-desired", "published-manifests", "instance-owners"} {
			records, err := f.s.List(kind)
			if err != nil || len(records) != 0 {
				t.Fatalf("rejected operation wrote %s: count=%d err=%v", kind, len(records), err)
			}
		}
		code, lookup, raw := req(t, admin, "GET", url+"/publication-requests/arbitrated-rejection", "", nil)
		if code != 200 || !reflect.DeepEqual(lookup["result"], rejected) {
			t.Fatalf("rejection changed: %d %s", code, raw)
		}
		// The failed prepared transaction did not even consume a generation counter.
		input["operationId"] = "fresh-after-arbitration"
		code, accepted, raw := req(t, admin, "POST", url+"/publish", "", input)
		if code != 200 || accepted["status"] != "publication-accepted" {
			t.Fatalf("fresh reviewed operation %d %s", code, raw)
		}
		instances, ok := accepted["instances"].([]any)
		if !ok || len(instances) != len(f.in.TargetIDs) {
			t.Fatalf("missing targets: %s", raw)
		}
		for _, v := range instances {
			p, ok := v.(map[string]any)
			if !ok || p["generation"] != "1" {
				t.Fatalf("rejected race consumed generation: %s", raw)
			}
		}
	})
	t.Run("acceptance fences competing negative receipt writer", func(t *testing.T) {
		f := newFleetFixture(t)
		admin := operatorClient()
		url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
		opened := openServerDraft(t, admin, url)
		checked := requireServerValidation(t, admin, url, opened["revisionToken"].(string))
		receiptID := "operator:arbitrated-acceptance"
		absence := []store.RecordCompare{{Kind: "publication-receipts", ID: receiptID}}
		var prior json.RawMessage
		if err := f.s.Get("publication-receipts", receiptID, &prior); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("unexpected receipt: %v", err)
		}
		input := map[string]any{"operationId": "arbitrated-acceptance", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]}
		code, accepted, raw := req(t, admin, "POST", url+"/publish", "", input)
		if code != 200 || accepted["status"] != "publication-accepted" {
			t.Fatalf("real acceptance %d %s", code, raw)
		}
		before := map[string]json.RawMessage{}
		for _, id := range f.in.TargetIDs {
			var value json.RawMessage
			if err := f.s.Get("agent-desired", id, &value); err != nil {
				t.Fatal(err)
			}
			before[id] = value
		}
		err := f.s.CompareAndPutRecords(absence, []store.RecordWrite{{Kind: "publication-receipts", ID: receiptID, Value: map[string]any{"status": "must-not-replace-acceptance"}}})
		if !errors.Is(err, store.ErrConflict) {
			t.Fatalf("negative writer escaped terminal fence: %v", err)
		}
		code, lookup, raw := req(t, admin, "GET", url+"/publication-requests/arbitrated-acceptance", "", nil)
		if code != 200 || !reflect.DeepEqual(lookup["result"], accepted) {
			t.Fatalf("acceptance changed: %d %s", code, raw)
		}
		for _, id := range f.in.TargetIDs {
			var after json.RawMessage
			if err := f.s.Get("agent-desired", id, &after); err != nil || !reflect.DeepEqual(before[id], after) {
				t.Fatalf("negative writer altered %s desired: %v", id, err)
			}
		}
	})
}
