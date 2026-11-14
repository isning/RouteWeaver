package httpapi_test

import (
	"net/http"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestOutputUsageIsCurrentOwnerOnlyAndNeverGuessesLegacyAttribution(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "ou-a")
	b := inviteClient(t, s, srv, "ou-b")
	now := time.Now().UTC()
	for _, v := range []struct {
		id, owner, output string
		bytes             int64
	}{{"a", a.id, "owned-output", 41}, {"legacy", a.id, "", 7}, {"b", b.id, "secret-output", 999}} {
		record := store.MeterRecord{MeterBatch: store.MeterBatch{UserID: v.owner, RouteID: "route", MeterID: "admission-budget", Epoch: v.id, Sequence: 1, RawBytes: v.bytes, ObservedAt: now}, RateMicros: service.RateScale, WeightedBytes: v.bytes}
		if v.output != "" {
			record.OutputID = v.output
			record.OutputRevision = "v1"
			record.BudgetID = "budget-" + v.id
		}
		if e := s.Put("ledger", v.id, record); e != nil {
			t.Fatal(e)
		}
	}
	code, out, raw := req(t, a.c, "GET", srv.URL+"/api/me/output-usage", "", nil)
	if code != 200 || out["period"] != "current-cycle" || out["complete"] != true || out["unattributedRawBytes"] != float64(7) {
		t.Fatalf("%d %s", code, raw)
	}
	rows := out["outputs"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["outputId"] != "owned-output" || rows[0].(map[string]any)["rawBytes"] != float64(41) {
		t.Fatalf("incorrect attributed rows: %s", raw)
	}
	code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+"/api/me/output-usage", "", nil)
	if code != 401 {
		t.Fatal(code)
	}
	code, _, _ = req(t, a.c, "GET", srv.URL+"/api/me/output-usage?userId="+b.id, "", nil)
	if code != 400 {
		t.Fatal(code)
	}
}
