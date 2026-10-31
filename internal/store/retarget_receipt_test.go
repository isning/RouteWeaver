package store_test

import (
	"errors"
	"routeweaver/internal/store"
	"testing"
)

func TestRetargetRejectedReceiptFencesAnAlreadyPreparedSuccessTransaction(t *testing.T) {
	s, err := store.Open(t.TempDir()+"/receipt.db", make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	old := map[string]string{"exit": "old"}
	if err = s.Put("server-deployments", "draft", old); err != nil {
		t.Fatal(err)
	}
	prepared := []store.RecordCompare{{Kind: "server-deployments", ID: "draft", Expected: old}, {Kind: "route-exit-receipts", ID: "actor:operation"}}
	rejected := map[string]string{"status": "draft-rejected", "actor": "actor", "requestToken": "exact-request"}
	if err = s.CompareAndPutRecords([]store.RecordCompare{prepared[1]}, []store.RecordWrite{{Kind: "route-exit-receipts", ID: "actor:operation", Value: rejected}}); err != nil {
		t.Fatal(err)
	}
	err = s.CompareAndPutRecords(prepared, []store.RecordWrite{{Kind: "server-deployments", ID: "draft", Value: map[string]string{"exit": "new"}}, {Kind: "route-exit-receipts", ID: "actor:operation", Value: map[string]string{"status": "draft-saved"}}})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("prepared commit escaped tombstone: %v", err)
	}
	var actual map[string]string
	if err = s.Get("server-deployments", "draft", &actual); err != nil || actual["exit"] != "old" {
		t.Fatalf("partial draft write %v %v", actual, err)
	}
	if err = s.Get("route-exit-receipts", "actor:operation", &actual); err != nil || actual["status"] != "draft-rejected" {
		t.Fatalf("receipt overwritten %v %v", actual, err)
	}
}
